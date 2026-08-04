# JNI entry points. BuildForegroundService.{start,update,stop} are @JvmStatic
# methods called ONLY from Rust via JNI (src/fg_service.rs); R8 cannot see JNI
# call sites, so with minify on (release) it strips them as unused. The class
# itself survives because the manifest declares it as a <service>, but its static
# methods do not, so the on-device layer build crashes with NoSuchMethodError on
# the first progress notification (reproduced: remove + reinstall Tearma). Keep
# the whole class and its companion so the JNI surface stays intact.
-keep class org.flaxandteal.greasan.BuildForegroundService { *; }
-keep class org.flaxandteal.greasan.BuildForegroundService$Companion { *; }
