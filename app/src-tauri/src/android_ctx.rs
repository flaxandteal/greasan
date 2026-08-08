//! Android JNI context bridge.
//!
//! Tauri v2 mobile runs a Java `WryActivity` (not a `NativeActivity`). The
//! `ndk_context` global - the shared slot every crate reads via
//! `ndk_context::android_context()` - is normally initialized by `ndk-glue`,
//! which a `NativeActivity` app links but a `WryActivity` app does NOT. Nothing
//! in wry/tao/tauri calls `ndk_context::initialize_android_context`, so that
//! global stays `None` and `android_context()` panics with
//! `"android context was not initialized"`. Because the panic unwinds into the
//! JNI `extern "C"` boundary (which cannot unwind), the process SIGABRTs.
//!
//! tao, however, *does* hold the live JavaVM + Activity (a global-ref-backed
//! `jobject`, valid across threads and for the process lifetime) in its own
//! `main_android_context()`. We bridge tao's context into `ndk_context` exactly
//! once at startup so both `offline.rs` and `builder_plugin.rs` work.
//!
//! We also expose a non-panicking [`context`] accessor so a missing context
//! surfaces as an `Err` to JS instead of aborting the whole app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

static INITIALIZED: AtomicBool = AtomicBool::new(false);
static INIT: Once = Once::new();

/// Bridge tao's Android context into the global `ndk_context` slot, exactly once.
///
/// Safe to call repeatedly (idempotent via `Once`) and from either the Tauri
/// `.setup()` hook or lazily from [`context`] if a command races ahead of setup.
pub fn init_from_tao() {
    INIT.call_once(|| {
        match tao::platform::android::prelude::main_android_context() {
            Some(ctx) => {
                // SAFETY: `java_vm` is the process JavaVM pointer and
                // `context_jobject` is a global-ref-backed Activity jobject, both
                // owned by tao for the process lifetime. `Once` guarantees this
                // runs exactly once, satisfying `initialize_android_context`'s
                // single-call contract.
                unsafe {
                    ndk_context::initialize_android_context(ctx.java_vm, ctx.context_jobject);
                }
                INITIALIZED.store(true, Ordering::SeqCst);
                eprintln!(
                    "[android] ndk_context initialized from tao (activity={})",
                    ctx.activity_name
                );
            }
            None => {
                eprintln!(
                    "[android] WARNING: tao main_android_context() is None; \
                     ndk_context NOT initialized (JNI-dependent commands will error)"
                );
            }
        }
    });
}

/// Non-panicking accessor for the Android context.
///
/// Returns `Err` - never panics/aborts - when the context is unavailable, so
/// JNI-dependent commands can return a graceful error to JS. Attempts a lazy
/// init in case a command runs before `.setup()`.
pub fn context() -> Result<ndk_context::AndroidContext, String> {
    if !INITIALIZED.load(Ordering::SeqCst) {
        init_from_tao();
    }
    if INITIALIZED.load(Ordering::SeqCst) {
        Ok(ndk_context::android_context())
    } else {
        Err("android context unavailable: ndk_context could not be initialized \
             (tao main_android_context was None)"
            .to_string())
    }
}
