use sha2::{Digest, Sha224};
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    pub host: String,
    pub port: u16,
    pub udp: bool,
    pub consumed: usize,
    pub reply: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Incomplete,
    Authentication,
    Invalid,
}

pub fn uuid_bytes(value: &str) -> Option<[u8; 16]> {
    if !value.is_ascii()
        || value.len() != 36
        || ![8, 13, 18, 23].iter().all(|&i| value.as_bytes()[i] == b'-')
    {
        return None;
    }
    let hex: String = value.chars().filter(|&c| c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn slice(data: &[u8], start: usize, size: usize) -> Result<&[u8], ParseError> {
    data.get(start..start + size).ok_or(ParseError::Incomplete)
}

fn address(
    data: &[u8],
    mut pos: usize,
    kind: u8,
    trojan: bool,
) -> Result<(String, usize), ParseError> {
    let host = match kind {
        1 => {
            let a = slice(data, pos, 4)?;
            pos += 4;
            Ipv4Addr::new(a[0], a[1], a[2], a[3]).to_string()
        }
        k if k == if trojan { 3 } else { 2 } => {
            let len = *data.get(pos).ok_or(ParseError::Incomplete)? as usize;
            pos += 1;
            let bytes = slice(data, pos, len)?;
            pos += len;
            let name = std::str::from_utf8(bytes).map_err(|_| ParseError::Invalid)?;
            if name.is_empty()
                || name.len() > 253
                || name
                    .bytes()
                    .any(|b| b <= 32 || b >= 127 || b"/\\@?#:%".contains(&b))
            {
                return Err(ParseError::Invalid);
            }
            name.to_owned()
        }
        k if k == if trojan { 4 } else { 3 } => {
            let a: [u8; 16] = slice(data, pos, 16)?.try_into().unwrap();
            pos += 16;
            Ipv6Addr::from(a).to_string()
        }
        _ => return Err(ParseError::Invalid),
    };
    Ok((host, pos))
}

pub fn vless(data: &[u8], user: &[u8; 16]) -> Result<Destination, ParseError> {
    if data.len() < 18 {
        return Err(ParseError::Incomplete);
    }
    if !equal(&data[1..17], user) {
        return Err(ParseError::Authentication);
    }
    let pos = 18 + data[17] as usize;
    let h = slice(data, pos, 4)?;
    let udp = match h[0] {
        1 => false,
        2 => true,
        _ => return Err(ParseError::Invalid),
    };
    let port = u16::from_be_bytes([h[1], h[2]]);
    if port == 0 || (udp && port != 53) {
        return Err(ParseError::Invalid);
    }
    let (host, consumed) = address(data, pos + 4, h[3], false)?;
    Ok(Destination {
        host,
        port,
        udp,
        consumed,
        reply: vec![data[0], 0],
    })
}

pub fn trojan(data: &[u8], password: &str) -> Result<Destination, ParseError> {
    if data.len() < 58 {
        return Err(ParseError::Incomplete);
    }
    let hash = format!("{:x}", Sha224::digest(password.as_bytes()));
    if !equal(&data[..56], hash.as_bytes()) {
        return Err(ParseError::Authentication);
    }
    if &data[56..58] != b"\r\n" {
        return Err(ParseError::Invalid);
    }
    let command = *data.get(58).ok_or(ParseError::Incomplete)?;
    let kind = *data.get(59).ok_or(ParseError::Incomplete)?;
    if command != 1 {
        return Err(ParseError::Invalid);
    }
    let (host, pos) = address(data, 60, kind, true)?;
    let tail = slice(data, pos, 4)?;
    let port = u16::from_be_bytes([tail[0], tail[1]]);
    if port == 0 || &tail[2..] != b"\r\n" {
        return Err(ParseError::Invalid);
    }
    Ok(Destination {
        host,
        port,
        udp: false,
        consumed: pos + 4,
        reply: vec![],
    })
}

pub fn parse(
    data: &[u8],
    user: &[u8; 16],
    password: &str,
    ev: bool,
    et: bool,
) -> Result<Destination, ParseError> {
    if data.is_empty() {
        return Err(ParseError::Incomplete);
    }
    if ev && data.first().is_some_and(|b| *b < 16) {
        return vless(data, user);
    }
    if et {
        return trojan(data, password);
    }
    Err(ParseError::Authentication)
}

pub fn endpoint(value: &str, default: u16) -> Option<(String, u16)> {
    if value.is_empty()
        || value
            .chars()
            .any(|c| c.is_whitespace() || "/@?#\\".contains(c))
    {
        return None;
    }
    if value.starts_with('[') {
        let end = value.find(']')?;
        let host = &value[1..end];
        host.parse::<Ipv6Addr>().ok()?;
        let port = if end + 1 == value.len() {
            default
        } else {
            value.get(end + 1..)?.strip_prefix(':')?.parse().ok()?
        };
        return (port != 0).then(|| (format!("[{host}]"), port));
    }
    let (host, port) = if let Some((host, port)) = value.rsplit_once(':') {
        (host, port.parse().ok()?)
    } else {
        (value, default)
    };
    if host.is_empty() || port == 0 || host.contains(':') {
        return None;
    }
    if !host.is_ascii()
        || host.len() > 253
        || !host.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return None;
    }
    Some((host.to_owned(), port))
}

/// Normalize a host and a separately supplied JSON port without accepting host:port in host.
pub fn specified_endpoint(host: &str, port: u64) -> Option<(String, u16)> {
    let port = u16::try_from(port).ok().filter(|p| *p != 0)?;
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<Ipv6Addr>() {
        return Some((ip.to_string(), port));
    }
    if host.contains(':') || host.contains(['[', ']']) {
        return None;
    }
    let (host, _) = endpoint(host, port)?;
    Some((host.to_ascii_lowercase(), port))
}

pub fn authority(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "00000000-1111-4222-8333-444444444444";
    fn request() -> Vec<u8> {
        let mut a = vec![0];
        a.extend(uuid_bytes(ID).unwrap());
        a.extend([0, 1, 1, 187, 2, 11]);
        a.extend(b"example.com");
        a
    }
    #[test]
    fn vless_fragmentation_and_payload() {
        let mut a = request();
        let n = a.len();
        a.extend(b"payload");
        for i in 0..n {
            assert_eq!(
                vless(&a[..i], &uuid_bytes(ID).unwrap()),
                Err(ParseError::Incomplete)
            );
        }
        let d = vless(&a, &uuid_bytes(ID).unwrap()).unwrap();
        assert_eq!(
            (d.host.as_str(), d.port, d.consumed),
            ("example.com", 443, n)
        );
        assert_eq!(&a[d.consumed..], b"payload");
    }
    #[test]
    fn reject_auth_and_non_dns_udp() {
        let mut a = request();
        a[1] = 1;
        assert_eq!(
            vless(&a, &uuid_bytes(ID).unwrap()),
            Err(ParseError::Authentication)
        );
        a = request();
        a[18] = 2;
        assert_eq!(
            vless(&a, &uuid_bytes(ID).unwrap()),
            Err(ParseError::Invalid)
        );
    }
    #[test]
    fn trojan_fragmentation_and_crlf() {
        let mut a = format!("{:x}\r\n", Sha224::digest(ID.as_bytes())).into_bytes();
        a.extend([1, 3, 11]);
        a.extend(b"example.com");
        a.extend([1, 187, 13, 10]);
        let n = a.len();
        a.extend(b"tls");
        for i in 0..n {
            assert_eq!(trojan(&a[..i], ID), Err(ParseError::Incomplete));
        }
        let d = trojan(&a, ID).unwrap();
        assert_eq!(d.port, 443);
        assert_eq!(&a[d.consumed..], b"tls");
        a[n - 1] = 0;
        assert_eq!(trojan(&a, ID), Err(ParseError::Invalid));
    }
    #[test]
    fn ipv6_and_endpoints() {
        assert_eq!(endpoint("[::1]:8443", 443), Some(("[::1]".into(), 8443)));
        assert!(endpoint("a:0", 443).is_none());
        assert!(endpoint("user@host:80", 443).is_none());
        assert!(uuid_bytes("no").is_none());
        assert!(uuid_bytes("éééééééééééééééééé").is_none());
        assert!(endpoint("bad!host:443", 443).is_none());
        assert_eq!(
            parse(&[], &uuid_bytes(ID).unwrap(), ID, true, false),
            Err(ParseError::Incomplete)
        );
    }
    #[test]
    fn separately_supplied_endpoints_have_canonical_ipv6_and_strict_ports() {
        let bare = specified_endpoint("2001:0db8:0:0:0:0:0:1", 8443).unwrap();
        assert_eq!(bare, ("2001:db8::1".into(), 8443));
        assert_eq!(
            specified_endpoint("[2001:db8::1]", 8443),
            Some(bare.clone())
        );
        assert_eq!(authority(&bare.0, bare.1), "[2001:db8::1]:8443");
        assert_eq!(
            specified_endpoint("EXAMPLE.COM", 443),
            Some(("example.com".into(), 443))
        );
        for (host, port) in [
            ("example.com", 0),
            ("example.com", 65536),
            ("example.com:80", 443),
            ("[example.com]", 443),
        ] {
            assert!(specified_endpoint(host, port).is_none());
        }
    }
}
