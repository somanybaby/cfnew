use crate::{config, protocol};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use futures_util::{
    future::{select, Either},
    pin_mut, StreamExt,
};
use serde_json::{json, Map, Value};
use std::{
    cell::RefCell,
    pin::Pin,
    rc::Rc,
    task::{Context as TaskContext, Poll},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use worker::*;

fn error(message: impl Into<String>) -> Error {
    Error::RustError(message.into())
}
fn headers() -> Result<Headers> {
    let h = Headers::new();
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        h.set(k, v)?;
    }
    Ok(h)
}
fn json_response(value: Value, status: u16) -> Result<Response> {
    Ok(Response::from_json(&value)?
        .with_status(status)
        .with_headers({
            let h = headers()?;
            h.set("content-type", "application/json; charset=utf-8")?;
            h
        }))
}
fn kv(env: &Env) -> Option<worker::kv::KvStore> {
    env.kv("C").or_else(|_| env.kv("c")).ok()
}
async fn saved(env: &Env) -> Result<Map<String, Value>> {
    match kv(env) {
        Some(k) => Ok(k
            .get("c")
            .json::<Value>()
            .await?
            .unwrap_or(json!({}))
            .as_object()
            .cloned()
            .unwrap_or_default()),
        None => Ok(Map::new()),
    }
}
fn environment(env: &Env) -> Map<String, Value> {
    let mut map = Map::new();
    for key in config::defaults().keys() {
        for alias in config::aliases(key) {
            if let Ok(value) = env.var(&alias) {
                let value = value.to_string();
                if !value.is_empty() {
                    map.insert(key.clone(), json!(value));
                    break;
                }
            }
        }
    }
    map
}
async fn persist(env: &Env, value: &Map<String, Value>) -> Result<()> {
    let k = kv(env).ok_or_else(|| error("KV required"))?;
    k.put("c", serde_json::to_string(value)?)?.execute().await?;
    k.put("c_ver", format!("{:.0}", js_sys::Date::now()))?
        .execute()
        .await?;
    Ok(())
}
async fn body_limited(req: &mut Request, limit: usize) -> Result<Vec<u8>> {
    if req
        .headers()
        .get("content-length")?
        .and_then(|s| s.parse::<usize>().ok())
        .is_some_and(|n| n > limit)
    {
        return Err(error("Body too large"));
    }
    let mut out = Vec::new();
    let mut stream = req.stream()?;
    while let Some(part) = stream.next().await {
        let part = part?;
        if out.len() + part.len() > limit {
            return Err(error("Body too large"));
        }
        out.extend(part);
    }
    Ok(out)
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, ctx: Context) -> Result<Response> {
    match handle(req, env, ctx).await {
        Ok(response) => Ok(response),
        Err(_) => json_response(json!({"error":"Request processing failed"}), 502),
    }
}

async fn handle(mut req: Request, env: Env, ctx: Context) -> Result<Response> {
    if req.method() == Method::Options {
        return Ok(Response::empty()?.with_status(204).with_headers(headers()?));
    }
    let url = req.url()?;
    let path = url.path();
    let upgrade = req
        .headers()
        .get("upgrade")?
        .is_some_and(|s| s.eq_ignore_ascii_case("websocket"));
    if path == "/" && req.method() == Method::Get && !upgrade {
        return Response::ok("hello");
    }
    let uid = env
        .var("u")
        .or_else(|_| env.var("U"))
        .map_err(|_| error("UUID required"))?
        .to_string()
        .trim()
        .to_lowercase();
    let user = protocol::uuid_bytes(&uid).ok_or_else(|| error("Invalid UUID"))?;
    let original = saved(&env).await?;
    let config = config::normalize(&environment(&env), &original);
    let custom = config::text(config.get("d"));
    let custom = custom.trim_matches('/');
    let custom_path = Url::parse(&format!("https://path.invalid/{custom}"))?
        .path()
        .to_owned();
    let suffix = path.strip_prefix(&format!("/{uid}")).or_else(|| {
        if !custom.is_empty() {
            path.strip_prefix(custom_path.as_str())
        } else {
            None
        }
    });
    match suffix {
        Some("/api/config") => {
            if req.method() == Method::Get {
                let mut c = config.clone();
                c.insert("uuid".into(), json!(uid));
                c.insert("coreVersion".into(), json!(config::VERSION));
                c.insert("implementation".into(), json!(config::IMPLEMENTATION));
                c.insert("kvEnabled".into(), json!(kv(&env).is_some()));
                return json_response(Value::Object(c), 200);
            }
            if req.method() != Method::Post {
                return json_response(json!({"error":"GET or POST required"}), 405);
            }
            if kv(&env).is_none() {
                return json_response(json!({"success":false,"message":"KV required"}), 503);
            }
            let bytes = match body_limited(&mut req, 1048576).await {
                Ok(b) => b,
                Err(_) => return json_response(json!({"error":"Configuration too large"}), 413),
            };
            let patch = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| config::patch(&original, v).ok());
            let Some(patch) = patch else {
                return json_response(json!({"error":"Invalid configuration"}), 400);
            };
            persist(&env, &patch).await?;
            let mut effective = config::normalize(&environment(&env), &patch);
            effective.insert("coreVersion".into(), json!(config::VERSION));
            return json_response(json!({"success":true,"config":effective}), 200);
        }
        Some("/region") => {
            let region = region(&config);
            let p = config::text(config.get("p"));
            return json_response(
                json!({"region":region,"manualRegion":config::text(config.get("wk")),"ci":p,"detectionMethod":if !config::text(config.get("wk")).is_empty(){"手动指定地区"}else if !p.is_empty(){"自定义 ProxyIP 模式"}else{"官方直连"},"timestamp":js_sys::Date::new_0().to_iso_string().as_string().unwrap_or_default()}),
                200,
            );
        }
        Some("/test-api") => {
            return json_response(
                json!({"detectedRegion":region(&config),"message":"API 正常运行"}),
                200,
            )
        }
        Some("/api/preferred-ips") => return preferred(&mut req, &env, original).await,
        _ => {}
    }
    let settings = Settings::new(&uid, user, &config, &url, upgrade);
    if upgrade {
        return websocket(&req, settings);
    }
    let first8 = format!("/{}", &uid[..8]);
    let tp = config::text(config.get("tp"));
    let trimmed = path.trim_end_matches('/');
    if req.method() == Method::Post
        && config::enabled(config.get("ex"), false)
        && (suffix == Some("")
            || trimmed == format!("/{uid}")
            || (!custom.is_empty() && trimmed == custom_path)
            || trimmed == first8
            || (!tp.is_empty() && trimmed == format!("/{}", tp.trim_matches('/'))))
    {
        return xhttp(req, settings, ctx).await;
    }
    json_response(json!({"error":"Not Found"}), 404)
}

fn region(c: &Map<String, Value>) -> String {
    let wk = config::text(c.get("wk"));
    if !wk.is_empty() {
        wk.to_uppercase()
    } else if !config::text(c.get("p")).is_empty() {
        "CUSTOM".into()
    } else {
        "CF".into()
    }
}

fn preferred_rows(raw: &str) -> Vec<Value> {
    raw.split([',', '\r', '\n'])
        .filter_map(|row| {
            let (target, name) = row.trim().split_once('#').unwrap_or((row.trim(), ""));
            let (host, port) = protocol::endpoint(target, 443)?;
            Some(json!({"ip":host,"port":port,"name":if name.is_empty(){target}else{name}}))
        })
        .collect()
}
async fn preferred(
    req: &mut Request,
    env: &Env,
    mut original: Map<String, Value>,
) -> Result<Response> {
    if kv(env).is_none() {
        return json_response(json!({"success":false,"error":"KV required"}), 503);
    }
    if config::text(original.get("ae")) != "yes" {
        return json_response(
            json!({"success":false,"error":"API management disabled"}),
            403,
        );
    }
    let mut rows = preferred_rows(&config::text(original.get("yx")));
    if req.method() == Method::Get {
        return json_response(json!({"success":true,"count":rows.len(),"data":rows}), 200);
    }
    if ![Method::Post, Method::Delete].contains(&req.method()) {
        return json_response(json!({"error":"Method not allowed"}), 405);
    }
    let body = body_limited(req, 1048576).await?;
    let body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return json_response(json!({"error":"Invalid JSON"}), 400),
    };
    let before = rows.len();
    let mut added = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    if req.method() == Method::Delete {
        if body.get("all") == Some(&Value::Bool(true)) {
            rows.clear();
        } else {
            let host = body.get("ip").and_then(Value::as_str).unwrap_or("");
            let port = body.get("port").and_then(Value::as_u64).unwrap_or(443);
            if host.is_empty() {
                return json_response(json!({"error":"IP required"}), 400);
            }
            rows.retain(|r| r["ip"] != host || r["port"] != port);
            if rows.len() == before {
                return json_response(json!({"error":"Not Found"}), 404);
            }
        }
    } else {
        let items = if let Some(a) = body.as_array() {
            a.clone()
        } else {
            vec![body]
        };
        for item in items {
            let host = item.get("ip").and_then(Value::as_str).unwrap_or("");
            let port = item.get("port").and_then(Value::as_u64).unwrap_or(443);
            let name = item.get("name").and_then(Value::as_str).unwrap_or(host);
            if port == 0
                || port > 65535
                || name.len() > 200
                || name.contains(['#', ',', '\r', '\n'])
                || protocol::endpoint(&format!("{host}:{port}"), 443).is_none()
            {
                errors.push(json!({"reason":"Invalid preferred endpoint"}));
                continue;
            }
            if rows.iter().any(|r| r["ip"] == host && r["port"] == port) {
                skipped.push(item);
                continue;
            }
            let row = json!({"ip":host,"port":port,"name":name});
            rows.push(row.clone());
            added.push(row);
        }
    }
    let raw = rows
        .iter()
        .map(|r| {
            format!(
                "{}:{}#{}",
                r["ip"].as_str().unwrap_or(""),
                r["port"],
                r["name"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    if raw.len() > 262144 {
        return json_response(json!({"error":"Preferred list too large"}), 413);
    }
    original.insert("yx".into(), json!(raw));
    persist(env, &original).await?;
    json_response(
        if req.method() == Method::Delete {
            json!({"success":true,"deletedCount":before-rows.len()})
        } else {
            json!({"success":!added.is_empty(),"added":added.len(),"skipped":skipped.len(),"errors":errors.len(),"data":{"addedIPs":added,"skippedIPs":skipped,"errors":errors}})
        },
        200,
    )
}

#[derive(Clone)]
struct Settings {
    user: [u8; 16],
    password: String,
    ev: bool,
    et: bool,
    free: bool,
    p: String,
    s: String,
    qj: String,
    wk: String,
    rm: String,
    uid: String,
}
impl Settings {
    fn new(uid: &str, user: [u8; 16], c: &Map<String, Value>, url: &Url, ws: bool) -> Self {
        let get = |key: &str| {
            if ws {
                if let Some((_, value)) = url.query_pairs().find(|(k, v)| k == key && !v.is_empty())
                {
                    return value.into_owned();
                }
            }
            config::text(c.get(key))
        };
        let password = config::text(c.get("tp"));
        Self {
            user,
            password: if password.is_empty() {
                uid.into()
            } else {
                password
            },
            ev: config::enabled(c.get("ev"), true),
            et: config::enabled(c.get("et"), false),
            free: config::enabled(c.get("freeCpu"), false),
            p: get("p"),
            s: get("s"),
            qj: config::text(c.get("qj")),
            wk: get("wk"),
            rm: get("rm"),
            uid: uid.into(),
        }
    }
}
#[derive(Default)]
struct Budget {
    enabled: bool,
    bytes: usize,
    blocks: usize,
}
impl Budget {
    fn consume(&mut self, n: usize) -> Result<()> {
        if self.enabled && (self.bytes + n > 384 * 1024 || self.blocks >= 96) {
            return Err(error("Connection budget exhausted"));
        }
        self.bytes += n;
        self.blocks += 1;
        Ok(())
    }
}

async fn timeout<T>(
    future: impl std::future::Future<Output = Result<T>>,
    seconds: u64,
) -> Result<T> {
    let delay = Delay::from(Duration::from_secs(seconds));
    pin_mut!(future);
    pin_mut!(delay);
    match select(future, delay).await {
        Either::Left((r, _)) => r,
        Either::Right(_) => Err(error("Connection timed out")),
    }
}
async fn open(host: &str, port: u16, tls: bool) -> Result<Socket> {
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.into()
    };
    let mut socket = Socket::builder()
        .secure_transport(if tls {
            SecureTransport::On
        } else {
            SecureTransport::Off
        })
        .allow_half_open(true)
        .connect(host, port)?;
    if let Err(e) = timeout(async { socket.opened().await.map(|_| ()) }, 8).await {
        let _ = socket.close().await;
        return Err(e);
    }
    Ok(socket)
}
fn io_error(_: std::io::Error) -> Error {
    error("TCP transfer failed")
}
struct Connection(Option<Socket>);
impl Connection {
    async fn close(&mut self) {
        if let Some(mut socket) = self.0.take() {
            let _ = socket.close().await;
        }
    }
}
impl tokio::io::AsyncRead for Connection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(self.0.as_mut().expect("live socket")).poll_read(cx, buf)
    }
}
impl tokio::io::AsyncWrite for Connection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(self.0.as_mut().expect("live socket")).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(self.0.as_mut().expect("live socket")).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(self.0.as_mut().expect("live socket")).poll_shutdown(cx)
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(mut socket) = self.0.take() {
            wasm_bindgen_futures::spawn_local(async move {
                let _ = socket.close().await;
            });
        }
    }
}
async fn proxy(host: &str, port: u16, setting: &str) -> Result<Socket> {
    let address = if setting.contains("://") {
        setting.to_owned()
    } else {
        format!("socks5://{setting}")
    };
    let u = Url::parse(&address)?;
    let hostname = u.host_str().ok_or_else(|| error("Invalid proxy"))?;
    let proxy_port = u.port().unwrap_or(if u.scheme() == "https" {
        443
    } else if u.scheme() == "http" {
        80
    } else {
        1080
    });
    let mut sock = open(hostname, proxy_port, u.scheme() == "https").await?;
    let handshake = async {
        if ["socks", "socks5"].contains(&u.scheme()) {
            let auth = !u.username().is_empty();
            sock.write_all(if auth { &[5, 2, 0, 2] } else { &[5, 1, 0] })
                .await
                .map_err(io_error)?;
            let mut answer = [0; 2];
            sock.read_exact(&mut answer).await.map_err(io_error)?;
            if answer[0] != 5 || answer[1] == 255 {
                return Err(error("Proxy authentication failed"));
            }
            if answer[1] == 2 {
                let user = decode_component(u.username());
                let pass = decode_component(u.password().unwrap_or(""));
                if user.len() > 255 || pass.len() > 255 {
                    return Err(error("Proxy credentials too long"));
                }
                let mut auth = vec![1, user.len() as u8];
                auth.extend(user.as_bytes());
                auth.push(pass.len() as u8);
                auth.extend(pass.as_bytes());
                sock.write_all(&auth).await.map_err(io_error)?;
                sock.read_exact(&mut answer).await.map_err(io_error)?;
                if answer != [1, 0] {
                    return Err(error("Proxy authentication failed"));
                }
            } else if answer[1] != 0 {
                return Err(error("Unsupported proxy method"));
            }
            let host = host.trim_matches(['[', ']']);
            let mut connect = vec![5, 1, 0];
            if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
                connect.push(1);
                connect.extend(ip.octets());
            } else if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
                connect.push(4);
                connect.extend(ip.octets());
            } else {
                if host.len() > 255 {
                    return Err(error("Hostname too long"));
                }
                connect.extend([3, host.len() as u8]);
                connect.extend(host.as_bytes());
            }
            connect.extend(port.to_be_bytes());
            sock.write_all(&connect).await.map_err(io_error)?;
            let mut head = [0; 4];
            sock.read_exact(&mut head).await.map_err(io_error)?;
            if head[0] != 5 || head[1] != 0 {
                return Err(error("Proxy connection refused"));
            }
            let len = match head[3] {
                1 => 4,
                4 => 16,
                3 => sock.read_u8().await.map_err(io_error)? as usize,
                _ => return Err(error("Invalid proxy reply")),
            };
            let mut rest = vec![0; len + 2];
            sock.read_exact(&mut rest).await.map_err(io_error)?;
        } else if ["http", "https"].contains(&u.scheme()) {
            let authority = if host.contains(':') && !host.starts_with('[') {
                format!("[{host}]:{port}")
            } else {
                format!("{host}:{port}")
            };
            let auth = if !u.username().is_empty() {
                format!(
                    "Proxy-Authorization: Basic {}\r\n",
                    STANDARD.encode(format!(
                        "{}:{}",
                        decode_component(u.username()),
                        decode_component(u.password().unwrap_or(""))
                    ))
                )
            } else {
                String::new()
            };
            sock.write_all(
                format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}\r\n")
                    .as_bytes(),
            )
            .await
            .map_err(io_error)?;
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                if bytes.len() >= 16384 {
                    return Err(error("Proxy reply too large"));
                }
                bytes.push(sock.read_u8().await.map_err(io_error)?);
            }
            let status = String::from_utf8_lossy(&bytes)
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_owned();
            if status != "200" {
                return Err(error("Proxy connection refused"));
            }
        } else {
            return Err(error("Unsupported proxy scheme"));
        }
        Ok(())
    };
    if let Err(e) = timeout(handshake, 10).await {
        let _ = sock.close().await;
        return Err(e);
    }
    Ok(sock)
}
fn decode_component(s: &str) -> String {
    let input = format!("x={}", s.replace('+', "%2B"));
    Url::parse(&format!("https://x.invalid/?{input}"))
        .ok()
        .and_then(|u| u.query_pairs().next().map(|(_, v)| v.into_owned()))
        .unwrap_or_default()
}

async fn dial(destination: &protocol::Destination, s: &Settings) -> Result<Socket> {
    let use_proxy = !s.s.is_empty();
    if use_proxy && s.qj != "no" {
        if let Ok(sock) = proxy(&destination.host, destination.port, &s.s).await {
            return Ok(sock);
        }
        if s.qj == "only" {
            return Err(error("Required proxy unavailable"));
        }
    }
    if !use_proxy || s.qj == "no" {
        if let Ok(sock) = open(&destination.host, destination.port, false).await {
            return Ok(sock);
        }
    }
    if use_proxy && s.qj == "no" {
        if let Ok(sock) = proxy(&destination.host, destination.port, &s.s).await {
            return Ok(sock);
        }
    }
    let fallback = if !s.p.is_empty() {
        protocol::endpoint(&s.p, destination.port).ok_or_else(|| error("Invalid fallback"))?
    } else {
        let region = s.wk.to_uppercase();
        if s.rm != "no"
            && ["HK", "US", "SG", "JP", "KR", "DE", "SE", "NL", "FI", "GB"]
                .contains(&region.as_str())
        {
            (format!("ProxyIP.{region}.CMLiussss.net"), 443)
        } else {
            ("pp.xy.kg".into(), 443)
        }
    };
    if use_proxy && s.qj != "no" {
        proxy(&fallback.0, fallback.1, &s.s).await
    } else {
        open(&fallback.0, fallback.1, false).await
    }
}

fn websocket(req: &Request, settings: Settings) -> Result<Response> {
    let early_protocol = req
        .headers()
        .get("sec-websocket-protocol")?
        .unwrap_or_default();
    let early = early_protocol.clone();
    let early = if early.is_empty() {
        Vec::new()
    } else {
        URL_SAFE_NO_PAD
            .decode(early.trim_end_matches('='))
            .map_err(|_| error("Invalid early data"))?
    };
    if early.len() > 16384 {
        return json_response(json!({"error":"Early data too large"}), 413);
    }
    let pair = WebSocketPair::new()?;
    let server = pair.server;
    wasm_bindgen_futures::spawn_local(async move {
        let result = session(&server, settings, early).await;
        let _ = server.close(
            Some(if result.is_ok() { 1000 } else { 1008 }),
            Some("Connection ended"),
        );
    });
    let response = Response::from_websocket(pair.client)?;
    if !early_protocol.is_empty() {
        let h = Headers::new();
        h.set("sec-websocket-protocol", &early_protocol)?;
        Ok(response.with_headers(h))
    } else {
        Ok(response)
    }
}

async fn session(server: &WebSocket, settings: Settings, mut buffered: Vec<u8>) -> Result<()> {
    let mut events = server.events()?;
    server.accept()?;
    let budget = Rc::new(RefCell::new(Budget {
        enabled: settings.free,
        ..Default::default()
    }));
    if !buffered.is_empty() {
        budget.borrow_mut().consume(buffered.len())?;
    }
    let destination = timeout(
        async {
            loop {
                match protocol::parse(
                    &buffered,
                    &settings.user,
                    &settings.password,
                    settings.ev,
                    settings.et,
                ) {
                    Ok(d) => break Ok(d),
                    Err(protocol::ParseError::Incomplete) => {}
                    Err(_) => break Err(error("Authentication or protocol rejected")),
                }
                if buffered.len() > 16384 {
                    break Err(error("Header too large"));
                }
                match events.next().await {
                    Some(Ok(WebsocketEvent::Message(m))) => {
                        let bytes = m.bytes().ok_or_else(|| error("Binary data required"))?;
                        budget.borrow_mut().consume(bytes.len())?;
                        buffered.extend(bytes);
                    }
                    _ => break Err(error("Connection ended before authentication")),
                }
            }
        },
        15,
    )
    .await?;
    let initial = buffered.split_off(destination.consumed);
    if destination.udp {
        return dns_session(server, &mut events, initial, destination.reply, budget).await;
    }
    let mut socket = Connection(Some(dial(&destination, &settings).await?));
    socket.write_all(&initial).await.map_err(io_error)?;
    let (mut reader, mut writer) = tokio::io::split(socket);
    let upload_budget = budget.clone();
    let download_budget = budget;
    let result = {
        let upload = async {
            while let Some(event) = events.next().await {
                match event? {
                    WebsocketEvent::Message(message) => {
                        let data = message
                            .bytes()
                            .ok_or_else(|| error("Binary data required"))?;
                        upload_budget.borrow_mut().consume(data.len())?;
                        writer.write_all(&data).await.map_err(io_error)?;
                    }
                    WebsocketEvent::Close(_) => break,
                }
            }
            Ok::<(), Error>(())
        };
        let download = async {
            let mut block = vec![0; 32768];
            let mut reply = destination.reply;
            loop {
                let n = reader.read(&mut block).await.map_err(io_error)?;
                if n == 0 {
                    break;
                }
                download_budget.borrow_mut().consume(n)?;
                if !reply.is_empty() {
                    reply.extend_from_slice(&block[..n]);
                    server.send_with_bytes(&reply)?;
                    reply.clear();
                } else {
                    server.send_with_bytes(&block[..n])?;
                }
            }
            Ok::<(), Error>(())
        };
        pin_mut!(upload);
        pin_mut!(download);
        match select(upload, download).await {
            Either::Left((r, _)) | Either::Right((r, _)) => r,
        }
    };
    let mut socket = reader.unsplit(writer);
    socket.close().await;
    result
}

async fn dns_session(
    server: &WebSocket,
    events: &mut EventStream<'_>,
    mut buffer: Vec<u8>,
    mut reply: Vec<u8>,
    budget: Rc<RefCell<Budget>>,
) -> Result<()> {
    loop {
        while buffer.len() >= 2 {
            let len = u16::from_be_bytes([buffer[0], buffer[1]]) as usize;
            if len == 0 {
                return Err(error("Invalid DNS frame"));
            }
            if buffer.len() < len + 2 {
                break;
            }
            let data = buffer[2..len + 2].to_vec();
            buffer.drain(..len + 2);
            let mut init = RequestInit::new();
            init.with_method(Method::Post)
                .with_body(Some(js_sys::Uint8Array::from(data.as_slice()).into()));
            let h = Headers::new();
            h.set("content-type", "application/dns-message")?;
            h.set("accept", "application/dns-message")?;
            init.with_headers(h);
            let mut response = timeout(
                Fetch::Request(Request::new_with_init("https://1.1.1.1/dns-query", &init)?).send(),
                10,
            )
            .await?;
            if response.status_code() != 200 {
                return Err(error("DNS service unavailable"));
            }
            let data = response.bytes().await?;
            if data.len() > 65535 {
                return Err(error("DNS response too large"));
            }
            budget.borrow_mut().consume(data.len())?;
            let mut packet = std::mem::take(&mut reply);
            packet.extend((data.len() as u16).to_be_bytes());
            packet.extend(data);
            server.send_with_bytes(packet)?;
        }
        if buffer.len() > 65537 {
            return Err(error("DNS buffer too large"));
        }
        match events.next().await {
            Some(Ok(WebsocketEvent::Message(m))) => {
                let bytes = m.bytes().ok_or_else(|| error("Binary data required"))?;
                budget.borrow_mut().consume(bytes.len())?;
                buffer.extend(bytes);
            }
            _ => return Ok(()),
        }
    }
}

async fn xhttp(mut req: Request, settings: Settings, ctx: Context) -> Result<Response> {
    let mut stream = req.stream()?;
    let mut bytes = Vec::new();
    let budget = Rc::new(RefCell::new(Budget {
        enabled: settings.free,
        ..Default::default()
    }));
    let destination = timeout(
        async {
            loop {
                match protocol::vless(&bytes, &settings.user) {
                    Ok(d) => {
                        if d.udp {
                            return Err(error("TCP required"));
                        }
                        break Ok(d);
                    }
                    Err(protocol::ParseError::Incomplete) => {}
                    Err(_) => break Err(error("Authentication or protocol rejected")),
                }
                if bytes.len() > 16384 {
                    break Err(error("Header too large"));
                }
                let chunk = stream
                    .next()
                    .await
                    .ok_or_else(|| error("Incomplete header"))??;
                budget.borrow_mut().consume(chunk.len())?;
                bytes.extend(chunk);
            }
        },
        15,
    )
    .await?;
    let mut socket = Connection(Some(dial(&destination, &settings).await?));
    socket
        .write_all(&bytes[destination.consumed..])
        .await
        .map_err(io_error)?;
    let (reader, mut writer) = tokio::io::split(socket);
    let up_budget = budget.clone();
    ctx.wait_until(async move {
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            if up_budget.borrow_mut().consume(chunk.len()).is_err()
                || writer.write_all(&chunk).await.is_err()
            {
                break;
            }
        }
    });
    let output = futures_util::stream::unfold(
        (reader, Some(destination.reply), budget),
        |(mut reader, reply, budget)| async move {
            if let Some(reply) = reply {
                return Some((Ok::<Vec<u8>, Error>(reply), (reader, None, budget)));
            }
            let mut block = vec![0; 32768];
            match reader.read(&mut block).await {
                Ok(0) => None,
                Ok(n) => {
                    block.truncate(n);
                    match budget.borrow_mut().consume(n) {
                        Ok(()) => {}
                        Err(e) => return Some((Err(e), (reader, None, budget.clone()))),
                    }
                    Some((Ok(block), (reader, None, budget)))
                }
                Err(_) => None,
            }
        },
    );
    let h = headers()?;
    h.set("content-type", "application/grpc")?;
    h.set("X-Accel-Buffering", "no")?;
    let key = format!("_{}", &settings.uid[25..31]);
    h.set(
        &settings.uid[1..7],
        &format!("https://x.invalid/?{key}={}", "a".repeat(256)),
    )?;
    Ok(Response::from_stream(output)?.with_headers(h))
}
