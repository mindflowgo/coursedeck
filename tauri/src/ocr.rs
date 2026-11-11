#[cfg(all(target_os = "macos", not(target_os = "ios")))]
pub mod macos {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizeTextRequestRevision3,
        VNRequest, VNRequestTextRecognitionLevel,
    };

    pub fn recognize_text_from_image_bytes(bytes: &[u8]) -> Result<String, String> {
        let data = NSData::with_bytes(bytes);
        let request = VNRecognizeTextRequest::new();
        unsafe { request.setRevision(VNRecognizeTextRequestRevision3) };
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        request.setAutomaticallyDetectsLanguage(true);

        let request_super: Retained<VNRequest> = unsafe { Retained::cast_unchecked(request.clone()) };
        let requests = NSArray::from_retained_slice(&[request_super]);
        let options = NSDictionary::new();
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );

        handler
            .performRequests_error(&requests)
            .map_err(|e| format!("Vision request failed: {:?}", e))?;

        let mut lines = Vec::new();
        if let Some(observations) = request.results() {
            for obs in observations {
                if let Some(candidate) = obs.topCandidates(1).firstObject() {
                    lines.push(candidate.string().to_string());
                }
            }
        }

        Ok(lines.join("\n"))
    }
}

#[cfg(target_os = "windows")]
pub mod windows {
    pub fn recognize_text_from_image_file(path: &str) -> Result<String, String> {
        win_ocr::ocr(path).map_err(|e| format!("Windows OCR failed: {:?}", e))
    }
}

pub fn is_ocr_supported() -> bool {
    #[cfg(any(all(target_os = "macos", not(target_os = "ios")), target_os = "windows"))]
    {
        true
    }

    #[cfg(not(any(all(target_os = "macos", not(target_os = "ios")), target_os = "windows")))]
    {
        false
    }
}

pub fn run_native_ocr(png_bytes: &[u8]) -> Result<String, String> {
    #[cfg(all(target_os = "macos", not(target_os = "ios")))]
    {
        macos::recognize_text_from_image_bytes(png_bytes)
    }

    #[cfg(target_os = "windows")]
    {
        let tmp = std::env::temp_dir().join(format!("ocr_{}.png", std::process::id()));
        std::fs::write(&tmp, png_bytes).map_err(|e| format!("Failed to write temp image: {e}"))?;
        let res = windows::recognize_text_from_image_file(&tmp.to_string_lossy());
        let _ = std::fs::remove_file(&tmp);
        res
    }

    #[cfg(not(any(all(target_os = "macos", not(target_os = "ios")), target_os = "windows")))]
    {
        let _ = png_bytes;
        Err("Native OCR is not supported on this platform".to_string())
    }
}
