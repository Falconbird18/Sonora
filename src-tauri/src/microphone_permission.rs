use gtk::prelude::*;
use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt};

fn is_app_origin(uri: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(uri) else {
        return false;
    };
    let app = url.host_str() == Some("localhost") && url.scheme() == "tauri";
    let dev = cfg!(debug_assertions)
        && url.host_str() == Some("localhost")
        && url.scheme() == "http"
        && url.port() == Some(5173);
    app || dev
}

pub fn configure(view: &webkit2gtk::WebView) {
    if let Some(settings) = WebViewExt::settings(view) {
        settings.set_enable_media_stream(true);
    }
    view.connect_permission_request(|view, request| {
        let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() else {
            return false;
        };
        if !media.is_for_audio_device() || media.is_for_video_device()
            || !is_app_origin(view.uri().as_deref().unwrap_or_default()) {
            request.deny();
            return true;
        }
        let dialog = gtk::MessageDialog::builder()
            .message_type(gtk::MessageType::Question)
            .modal(true)
            .destroy_with_parent(true)
            .text("Allow Sonora to use your microphone?")
            .secondary_text("The tuner uses microphone audio to detect pitch on your device. Stop the tuner to release the microphone.")
            .build();
        if let Some(parent) = view.toplevel().and_then(|widget| widget.downcast::<gtk::Window>().ok()) {
            dialog.set_transient_for(Some(&parent));
        }
        dialog.add_buttons(&[("Cancel", gtk::ResponseType::Cancel), ("Allow microphone", gtk::ResponseType::Accept)]);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        let request = request.clone();
        // Retain the request until the user responds; never auto-grant access.
        dialog.connect_response(move |dialog, response| {
            if response == gtk::ResponseType::Accept { request.allow(); }
            else { request.deny(); }
            dialog.close();
        });
        dialog.show_all();
        true
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn microphone_requests_are_limited_to_the_app() {
        assert!(is_app_origin("tauri://localhost/index.html"));
        assert_eq!(
            is_app_origin("http://localhost:5173/"),
            cfg!(debug_assertions)
        );
        for uri in [
            "https://example.com",
            "https://localhost",
            "http://localhost:5174",
            "tauri://localhost.evil.test",
            "not a URL",
        ] {
            assert!(!is_app_origin(uri), "{uri}");
        }
    }
}
