// SPDX-License-Identifier: MIT
//! Everything the bridge takes from outside: the upstream URL, the token and the
//! local port. Each is parsed once here, so the relay can trust its inputs.

use std::collections::HashMap;
use std::fmt;

use anyhow::{Context, Result, bail};
use url::{Host, Url};

pub const DEFAULT_ENDPOINT: &str = "wss://minecraft.yadokani389.net/minecraft";
pub const DEFAULT_PORT: u16 = 25565;
pub const URL_VAR: &str = "MC_BRIDGE_URL";
pub const PORT_VAR: &str = "MC_BRIDGE_PORT";
pub const TOKEN_VAR: &str = "MC_BRIDGE_TOKEN";

/// Read from the working directory alone; a file further up belongs to another project.
const DOTENV: &str = ".env";

/// The server's WebSocket endpoint. `wss:` anywhere, plus `ws:` on numeric loopback
/// only, so the bearer token never crosses a network in clear text.
#[derive(Clone)]
pub struct Endpoint(Url);

/// The shared secret for the server. `Debug` hides it so no log line can leak it.
#[derive(Clone)]
pub struct Token(String);

/// What one tunneled connection needs: where to go and what to present.
#[derive(Clone)]
pub struct Target {
    pub endpoint: Endpoint,
    pub token: Token,
}

#[derive(Default)]
pub struct Settings {
    pub endpoint: Option<Endpoint>,
    pub port: Option<u16>,
    pub token: Option<Token>,
}

impl Settings {
    /// Arguments, then the process environment, then `.env` in the working directory.
    pub fn load(endpoint: Option<Endpoint>, port: Option<u16>) -> Result<Self> {
        let file = dotenv()?;
        Ok(Self {
            endpoint: match endpoint {
                Some(endpoint) => Some(endpoint),
                None => setting(&file, URL_VAR, Endpoint::parse)?,
            },
            port: match port {
                Some(port) => Some(port),
                None => setting(&file, PORT_VAR, parse_port)?,
            },
            token: setting(&file, TOKEN_VAR, Token::parse)?,
        })
    }
}

/// One value from the process environment, else from `.env`. The error names the source,
/// and a token is never repeated in it.
fn setting<T>(
    file: &HashMap<String, String>,
    key: &str,
    parse: fn(&str) -> Result<T>,
) -> Result<Option<T>> {
    let (origin, value) = match std::env::var(key) {
        Ok(value) if !value.is_empty() => ("the environment", value),
        _ => match file.get(key).filter(|value| !value.is_empty()) {
            Some(value) => (".env", value.clone()),
            None => return Ok(None),
        },
    };
    parse(&value)
        .with_context(|| format!("{key} in {origin} is not usable"))
        .map(Some)
}

/// `.env` as key and value pairs, leaving the process environment alone.
fn dotenv() -> Result<HashMap<String, String>> {
    let entries = match dotenvy::from_path_iter(DOTENV) {
        Ok(entries) => entries,
        Err(error) if error.not_found() => return Ok(HashMap::new()),
        Err(error) => bail!(".env could not be opened: {error}"),
    };
    let mut values = HashMap::new();
    for entry in entries {
        let (key, value) = entry.map_err(dotenv_error)?;
        values.insert(key, value);
    }
    Ok(values)
}

/// dotenvy quotes the line it could not parse, and a mistyped token line must never reach
/// the terminal, so its text stays out of every message.
fn dotenv_error(error: dotenvy::Error) -> anyhow::Error {
    match error {
        dotenvy::Error::LineParse(..) => {
            anyhow::anyhow!(".env has a line that is neither a comment nor KEY=VALUE")
        }
        error => anyhow::anyhow!(".env could not be read: {error}"),
    }
}

impl Endpoint {
    pub fn parse(input: &str) -> Result<Self> {
        if !input.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) || input.contains(['\\', '#']) {
            bail!("the server URL must be printable ASCII without spaces, '#' or '\\'");
        }
        // The URL parser drops an empty authority and empty userinfo, so check the
        // text the player typed before trusting the parsed host.
        let authority = input.split_once("://").map_or("", |(_, rest)| {
            rest.split(['/', '?']).next().unwrap_or_default()
        });
        if authority.is_empty() || authority.contains('@') {
            bail!("the server URL needs a host and no credentials; the token authenticates");
        }
        let mut url = Url::parse(input).map_err(|error| anyhow::anyhow!("invalid URL: {error}"))?;
        if !url.has_host() {
            bail!("the server URL needs a host");
        }
        match url.scheme() {
            "wss" => {}
            "ws" => {
                if url.host_str() == Some("localhost") {
                    url.set_host(Some("127.0.0.1")).map_err(|_| {
                        anyhow::anyhow!("the localhost URL could not be normalized")
                    })?;
                }
                let loopback = match url.host() {
                    Some(Host::Ipv4(address)) => address.is_loopback(),
                    Some(Host::Ipv6(address)) => address.is_loopback(),
                    _ => false,
                };
                if !loopback {
                    bail!(
                        "use wss: for a remote server; ws: is only allowed on loopback addresses"
                    );
                }
            }
            scheme => bail!("unsupported URL scheme '{scheme}'; use wss: or ws:"),
        }
        Ok(Self(url))
    }

    pub fn url(&self) -> &Url {
        &self.0
    }
}

impl Token {
    pub fn parse(value: &str) -> Result<Self> {
        if value.is_empty() || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
            bail!("the token must be printable ASCII without spaces");
        }
        Ok(Self(value.to_owned()))
    }

    /// The one place the secret leaves its wrapper: the Authorization header, marked
    /// sensitive so no HTTP debug output prints it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Token(..)")
    }
}

pub fn parse_port(value: &str) -> Result<u16> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("'{value}' is not a port number");
    }
    value
        .parse()
        .map_err(|_| anyhow::anyhow!("'{value}' is not a port number between 0 and 65535"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(input: &str) -> String {
        Endpoint::parse(input).map_or_else(
            |error| format!("error: {error}"),
            |url| url.url().to_string(),
        )
    }

    #[test]
    fn accepts_secure_endpoints() {
        assert_eq!(endpoint(DEFAULT_ENDPOINT), DEFAULT_ENDPOINT);
        assert_eq!(endpoint("wss://example.com"), "wss://example.com/");
        assert_eq!(
            endpoint("wss://localhost:8787/minecraft"),
            "wss://localhost:8787/minecraft"
        );
    }

    #[test]
    fn normalizes_localhost_and_only_trusts_loopback_ws() {
        assert_eq!(
            endpoint("ws://localhost:8787/minecraft"),
            "ws://127.0.0.1:8787/minecraft"
        );
        assert_eq!(
            endpoint("ws://127.0.0.1:8787/minecraft"),
            "ws://127.0.0.1:8787/minecraft"
        );
        assert_eq!(
            endpoint("ws://[::1]:8787/minecraft"),
            "ws://[::1]:8787/minecraft"
        );
        assert!(endpoint("ws://192.168.1.2:8787/minecraft").starts_with("error:"));
        assert!(endpoint("ws://minecraft.example.com/minecraft").starts_with("error:"));
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_urls() {
        for input in [
            "",
            "http://example.com/minecraft",
            "wss://user:secret@example.com/minecraft",
            "wss://user@example.com/minecraft",
            "wss://@example.com/minecraft",
            "wss://example.com/minecraft#token",
            "wss://example.com/mine craft",
            "wss://example.com/minecraft\\",
            "wss://exa\tmple.com/minecraft",
            "wss://exämple.com/minecraft",
            "wss:///minecraft",
            "wss:/minecraft",
            "wss:minecraft",
        ] {
            assert!(
                Endpoint::parse(input).is_err(),
                "{input:?} should not be accepted"
            );
        }
    }

    #[test]
    fn hides_the_token_from_debug_output() {
        let token = Token::parse("s3cret-value").expect("valid token");
        assert_eq!(format!("{token:?}"), "Token(..)");
        assert_eq!(token.expose(), "s3cret-value");
    }

    #[test]
    fn accepts_printable_tokens_only() {
        assert!(Token::parse("").is_err());
        assert!(Token::parse("has space").is_err());
        assert!(Token::parse("tab\there").is_err());
        assert!(Token::parse("ünïcode").is_err());
        assert!(Token::parse("aZ09-_.~!@$%^&*()+={}[]:;,?/<>\"").is_ok());
    }

    #[test]
    fn parses_ports_from_digits_only() {
        assert_eq!(parse_port("25565").unwrap(), 25565);
        assert_eq!(parse_port("0").unwrap(), 0);
        assert!(parse_port("65536").is_err());
        assert!(parse_port("-1").is_err());
        assert!(parse_port("25_565").is_err());
        assert!(parse_port("").is_err());
    }
}
