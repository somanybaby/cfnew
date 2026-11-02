use serde_json::{json, Map, Value};

pub const VERSION: &str = "2026.10.17.2";
pub const IMPLEMENTATION: &str = "rust-wasm-0.1.0";
pub const BOOL_KEYS: &[&str] = &[
    "freeCpu",
    "ev",
    "et",
    "ex",
    "ech",
    "ena",
    "epd",
    "epi",
    "egi",
    "ipv4",
    "ipv6",
    "ispMobile",
    "ispUnicom",
    "ispTelecom",
    "jk",
];

pub fn defaults() -> Map<String, Value> {
    json!({"freeCpu":"no","wk":"","ev":"yes","et":"no","ex":"no","ech":"no","tp":"","customDNS":"https://223.5.5.5/dns-query","customECHDomain":"cloudflare-ech.com","alpn":"","d":"","p":"","yx":"","yxURL":"","s":"","homepage":"","scu":"https://url.v1.mk/sub","ena":"no","epd":"yes","epi":"yes","egi":"yes","ae":"","rm":"","qj":"","dkby":"no","yxby":"","ipv4":"yes","ipv6":"yes","ispMobile":"yes","ispUnicom":"yes","ispTelecom":"yes","jk":"no"}).as_object().unwrap().clone()
}

pub fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub fn enabled(value: Option<&Value>, default: bool) -> bool {
    match text(value).trim().to_lowercase().as_str() {
        "yes" | "true" | "1" | "on" => true,
        "no" | "false" | "0" | "off" => false,
        _ => default,
    }
}

pub fn aliases(key: &str) -> Vec<String> {
    let mut out = vec![key.to_owned(), key.to_uppercase()];
    let special = match key {
        "freeCpu" => Some("FREE_CPU"),
        "customDNS" => Some("CUSTOM_DNS"),
        "customECHDomain" => Some("CUSTOM_ECH_DOMAIN"),
        "yxURL" => Some("YX_URL"),
        "ispMobile" => Some("ISP_MOBILE"),
        "ispUnicom" => Some("ISP_UNICOM"),
        "ispTelecom" => Some("ISP_TELECOM"),
        _ => None,
    };
    if let Some(s) = special {
        out.push(s.into());
    }
    out
}

pub fn normalize(
    environment: &Map<String, Value>,
    saved: &Map<String, Value>,
) -> Map<String, Value> {
    let defaults = defaults();
    let mut result = defaults.clone();
    for (k, v) in environment.iter().chain(saved) {
        if defaults.contains_key(k) {
            result.insert(k.clone(), v.clone());
        }
    }
    for &key in BOOL_KEYS {
        let b = enabled(result.get(key), enabled(defaults.get(key), false));
        result.insert(key.into(), json!(if b { "yes" } else { "no" }));
    }
    if !["ev", "et", "ex"]
        .iter()
        .any(|k| enabled(result.get(*k), false))
    {
        result.insert("ev".into(), json!("yes"));
    }
    if enabled(result.get("ech"), false) {
        result.insert("dkby".into(), json!("yes"));
    }
    let alpn = text(result.get("alpn"));
    if ![
        "",
        "h3",
        "h2",
        "http/1.1",
        "h3,h2",
        "h2,http/1.1",
        "h3,h2,http/1.1",
    ]
    .contains(&alpn.as_str())
    {
        result.insert("alpn".into(), json!(""));
    }
    result
}

pub fn patch(
    saved: &Map<String, Value>,
    update: Value,
) -> Result<Map<String, Value>, &'static str> {
    let mut update = update
        .as_object()
        .ok_or("Configuration must be an object")?
        .clone();
    if let Some(p) = update.remove("customIP") {
        update.entry("p".to_owned()).or_insert(p);
    }
    let known = defaults();
    let mut out = saved.clone();
    for (key, value) in update {
        if !known.contains_key(&key) || value.is_array() || value.is_object() {
            return Err("Unknown field or invalid value");
        }
        if let Value::String(s) = &value {
            if s.chars().count() > if key == "yx" { 262144 } else { 16384 } {
                return Err("Field too long");
            }
        }
        if value.is_null() || value == "" {
            out.remove(&key);
        } else {
            out.insert(key, value);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalize_preserves_priority_and_safety() {
        let env = json!({"et":"yes","ech":"no"});
        let saved = json!({"ev":"no","et":"no","ex":"no","ech":true});
        let c = normalize(env.as_object().unwrap(), saved.as_object().unwrap());
        assert_eq!(c["ev"], "yes");
        assert_eq!(c["dkby"], "yes");
        assert_eq!(c["ech"], "yes");
    }
    #[test]
    fn patch_is_atomic_and_removal_restores_defaults() {
        let before = json!({"ev":"no","et":"yes"}).as_object().unwrap().clone();
        assert!(patch(&before, json!({"u":"secret"})).is_err());
        assert_eq!(before["ev"], "no");
        let after = patch(&before, json!({"ev":null,"customIP":"relay.example:443"})).unwrap();
        assert!(!after.contains_key("ev"));
        assert_eq!(after["p"], "relay.example:443");
        assert!(patch(&before, json!({"s":{"bad":true}})).is_err());
    }
}
