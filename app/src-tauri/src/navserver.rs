// SPDX-License-Identifier: AGPL-3.0-or-later
//! Debug-only navigation channel for DETERMINISTIC driving (tests, screencasts) —
//! a stand-in for real deep links, which are blocked on Android by an upstream
//! tao panic on typeless VIEW intents (tao ndk_glue handle_intent). Reach it from
//! the host via an adb port forward:
//!
//!   adb forward tcp:8787 tcp:8787
//!   curl -s localhost:8787/nav/map/baile      # or /nav/layers, /nav/word/baile …
//!
//! It emits a `nav` event carrying the route ("map/baile"); the frontend
//! (src/lib/deeplink.ts) turns that into `greasan://map/baile` and routes it.
//!
//! Gated behind the `nav-server` cargo feature, so it is ENTIRELY absent from any
//! build not made for driving (never enable it for a public release).
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{AppHandle, Emitter, Runtime};

const PORT: u16 = 8787;

/// Spawn the listener thread. Binds loopback only; never reachable off-device
/// except through an explicit `adb forward`.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[navserver] bind 127.0.0.1:{PORT} failed: {e}");
                return;
            }
        };
        eprintln!("[navserver] listening on 127.0.0.1:{PORT} — adb forward tcp:{PORT} tcp:{PORT}");
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            // Request line: "GET /nav/<route> HTTP/1.1" → route = "<route>".
            let route = req
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .map(|p| {
                    p.trim_start_matches("/nav/")
                        .trim_start_matches('/')
                        .split(['?', '#'])
                        .next()
                        .unwrap_or("")
                        .to_string()
                })
                .unwrap_or_default();
            if !route.is_empty() {
                let _ = app.emit("nav", route.clone());
            }
            let body = format!("nav: {route}\n");
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
}
