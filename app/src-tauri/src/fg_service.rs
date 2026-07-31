//! Android foreground-service bridge.
//!
//! A long on-device build (full Téarma is ~50 min) must survive the user
//! switching away — a backgrounded process holding >1GB is the first thing the
//! low-memory killer reaps. An Android *foreground service* with an ongoing
//! notification both drops the kill priority AND surfaces a progress bar in the
//! notification shade, so the build is visible without opening the app.
//!
//! The Android side (`BuildForegroundService.kt`) owns the channel + notification
//! and the `startForeground` call; here we just invoke its static
//! `start`/`update`/`stop` methods over JNI. Every call is best-effort: if the
//! JNI context or the class isn't available, we log and move on — the build must
//! never fail because the notification couldn't be shown.

#[cfg(target_os = "android")]
mod imp {
    use jni::objects::{JObject, JValue};
    use jni::JNIEnv;

    const CLASS: &str = "org.flaxandteal.greasan.BuildForegroundService";

    /// Run `f` with an attached env + the Activity (a Context). Best-effort.
    fn with_env<F>(what: &str, f: F)
    where
        F: FnOnce(&mut JNIEnv, &JObject) -> Result<(), jni::errors::Error>,
    {
        let run = || -> Result<(), String> {
            let ctx = crate::android_ctx::context()?;
            let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
                .map_err(|e| format!("JVM: {e}"))?;
            let mut env = vm
                .attach_current_thread()
                .map_err(|e| format!("attach: {e}"))?;
            let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
            f(&mut env, &activity).map_err(|e| format!("{what}: {e}"))
        };
        if let Err(e) = run() {
            eprintln!("[fg_service] {e}");
        }
    }

    /// Load our app class via the Activity's classloader. `FindClass` on a
    /// background (build) thread uses the system loader, which can't see app
    /// classes — so we resolve through `activity.getClassLoader().loadClass(..)`.
    fn load_class<'a>(
        env: &mut JNIEnv<'a>,
        activity: &JObject,
    ) -> Result<jni::objects::JClass<'a>, jni::errors::Error> {
        let loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string(CLASS)?;
        let class = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name.into())],
            )?
            .l()?;
        Ok(class.into())
    }

    pub fn start(text: &str) {
        with_env("start", |env, activity| {
            let class = load_class(env, activity)?;
            let jtext = env.new_string(text)?;
            env.call_static_method(
                class,
                "start",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::Object(activity), JValue::Object(&jtext.into())],
            )?;
            Ok(())
        });
    }

    pub fn update(text: &str, pct: i32) {
        with_env("update", |env, activity| {
            let class = load_class(env, activity)?;
            let jtext = env.new_string(text)?;
            env.call_static_method(
                class,
                "update",
                "(Landroid/content/Context;Ljava/lang/String;I)V",
                &[
                    JValue::Object(activity),
                    JValue::Object(&jtext.into()),
                    JValue::Int(pct),
                ],
            )?;
            Ok(())
        });
    }

    pub fn stop() {
        with_env("stop", |env, activity| {
            let class = load_class(env, activity)?;
            env.call_static_method(
                class,
                "stop",
                "(Landroid/content/Context;)V",
                &[JValue::Object(activity)],
            )?;
            Ok(())
        });
    }
}

#[cfg(target_os = "android")]
pub use imp::{start, stop, update};

#[cfg(not(target_os = "android"))]
pub fn start(_text: &str) {}
#[cfg(not(target_os = "android"))]
pub fn update(_text: &str, _pct: i32) {}
#[cfg(not(target_os = "android"))]
pub fn stop() {}
