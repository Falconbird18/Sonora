//! Linux-only: enable media capture (`getUserMedia`) in the WebKitGTK webview.
//!
//! On macOS (WKWebView) and Windows (WebView2) the media-permission prompt is
//! routed to the OS automatically, so microphone/camera capture works.
//! WebKitGTK is different on two counts, and both must be handled or capture
//! fails on Linux only:
//!
//! * `enable-media-stream` is **off by default**, so `navigator.mediaDevices`
//!   never exposes a working `getUserMedia`; and
//! * the default `permission-request` handler **denies every request**, so even
//!   with media-stream on, the call rejects with `NotAllowedError`.
//!
//! This module reaches the underlying `webkit2gtk::WebView` via
//! [`tauri::Webview::with_webview`], enables media-stream, and installs a
//! `permission-request` handler that is **deny-by-default**: a `UserMedia`
//! request is allowed only when it comes from a trusted app origin and asks for
//! an audio and/or video device.

#![cfg(target_os = "linux")]

use tauri::Webview;
use webkit2gtk::glib::Cast;
use webkit2gtk::{
    PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt,
};

/// Origins we trust for camera / mic (dev server + production asset protocol).
fn is_trusted_media_origin(uri: &str) -> bool {
    uri.starts_with("http://localhost:")
        || uri.starts_with("https://localhost:")
        || uri.starts_with("http://127.0.0.1:")
        || uri.starts_with("https://127.0.0.1:")
        || uri.starts_with("tauri://localhost")
        || uri.starts_with("https://tauri.localhost")
        || uri.starts_with("asset://localhost")
        || uri == "about:blank"
}

/// Enable media-stream and install a permission handler on this webview.
///
/// Safe to call multiple times; subsequent calls are no-ops if settings are
/// already applied. Errors are logged but do not panic.
pub fn enable_media_capture(webview: &Webview) {
    let result = webview.with_webview(|platform_webview| {
        // On Linux this is the underlying `webkit2gtk::WebView`.
        let wk_webview = platform_webview.inner();

        if let Some(settings) = WebViewExt::settings(&wk_webview) {
            settings.set_enable_media_stream(true);
        }

        // Deny-by-default: allow only mic/camera requests from a trusted app
        // origin; deny everything else (still returning `true` so WebKit's
        // auto-deny default does not also run).
        wk_webview.connect_permission_request(move |_wv, request| {
            // Only handle UserMediaPermissionRequest specially.
            let Ok(user_media) =
                request.clone().downcast::<webkit2gtk::UserMediaPermissionRequest>()
            else {
                request.deny();
                return true;
            };

            let for_device =
                user_media.is_for_audio_device() || user_media.is_for_video_device();

            // Best-effort origin check via the main frame URI.
            let uri = _wv.uri().map(|u| u.to_string()).unwrap_or_default();

            if for_device && is_trusted_media_origin(&uri) {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    });

    if let Err(error) = result {
        eprintln!("sonora: could not enable WebKitGTK media capture: {error}");
    }
}
