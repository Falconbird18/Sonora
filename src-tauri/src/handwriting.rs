//! Compact on-device text recognition. No network or external model server.
use ort::{environment::Environment, session::Session, value::Tensor};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};

struct TextRecognizer {
    session: Session,
    _environment: Environment,
}
static RECOGNIZER: OnceLock<Mutex<Option<TextRecognizer>>> = OnceLock::new();

fn with_recognizer<T>(action: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let mut guard = RECOGNIZER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Handwriting engine needs to be restarted.".to_string())?;
    if guard.is_none() {
        let environment = ort::init()
            .with_name("Sonora handwriting")
            .with_telemetry(false)
            .build()
            .map_err(|e| e.to_string())?;
        let session = Session::builder(&environment)
            .map_err(|e| e.to_string())?
            .with_intra_threads(1)
            .map_err(|e| e.to_string())?
            .commit_from_memory(include_bytes!("../../public/handwriting/text-int8.onnx"))
            .map_err(|e| e.to_string())?;
        *guard = Some(TextRecognizer {
            session,
            _environment: environment,
        });
    }
    action(&mut guard.as_mut().unwrap().session)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextResult {
    text: String,
    confidence: f32,
    inference_ms: f64,
}
fn infer(input: Vec<f32>, width: usize) -> Result<TextResult, String> {
    if !(4..=1024).contains(&width)
        || width % 4 != 0
        || input.len() != 64 * width
        || input
            .iter()
            .any(|v| !v.is_finite() || *v < -1.01 || *v > 1.01)
    {
        return Err("Invalid handwriting input.".into());
    }
    with_recognizer(|session| {
        let start = std::time::Instant::now();
        let tensor =
            Tensor::from_array(([1usize, 1, 64, width], input)).map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs!["image" => tensor])
            .map_err(|e| e.to_string())?;
        let (shape, logits) = outputs["log_probs"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        if shape.len() != 3 || shape[2] != 96 {
            return Err("Invalid handwriting model output.".into());
        }
        let mut text = String::new();
        let mut previous = 0;
        let mut confidences = Vec::<f32>::new();
        for frame in logits.chunks_exact(96) {
            let (best, value) = frame
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .unwrap();
            let probability = value.exp();
            if best != 0 && best != previous {
                text.push(char::from_u32(best as u32 + 31).unwrap());
                confidences.push(probability);
            } else if best != 0 && best == previous {
                if let Some(last) = confidences.last_mut() {
                    *last = last.max(probability);
                }
            }
            previous = best;
        }
        let confidence = if confidences.is_empty() {
            0.0
        } else {
            confidences.iter().sum::<f32>() / confidences.len() as f32
        };
        Ok(TextResult {
            text: text.trim().to_string(),
            confidence,
            inference_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    })
}

#[tauri::command]
pub async fn prepare_handwriting_recognizer() -> Result<(), String> {
    tokio::task::spawn_blocking(|| infer(vec![-1.0; 64 * 128], 128).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn recognize_handwriting_text(
    input: Vec<f32>,
    width: usize,
) -> Result<TextResult, String> {
    tokio::task::spawn_blocking(move || infer(input, width))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_input_before_loading_model() {
        assert!(infer(vec![], 64).is_err());
        assert!(infer(vec![f32::NAN; 256], 4).is_err());
        assert!(infer(vec![-1.0; 256], 3).is_err());
    }
    #[test]
    fn blank_ink_is_not_invented_text() {
        let result = infer(vec![-1.0; 64 * 128], 128).unwrap();
        assert!(result.text.is_empty());
    }
    #[test]
    fn reads_real_handwritten_text() {
        let bytes = include_bytes!("../../tests/fixtures/handwriting-hello-input.f32");
        let input: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let width = input.len() / 64;
        let result = infer(input, width).unwrap();
        assert_eq!(result.text, "hello world");
        assert!(result.confidence > 0.85);
    }
    #[test]
    #[ignore = "Run explicitly for native CPU latency measurement"]
    fn native_handwriting_benchmark() {
        let bytes = include_bytes!("../../tests/fixtures/handwriting-hello-input.f32");
        let input: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let width = input.len() / 64;
        let _ = infer(input.clone(), width).unwrap();
        for _ in 0..6 {
            let result = infer(input.clone(), width).unwrap();
            println!("{}: {:.2} ms", result.text, result.inference_ms);
            assert_eq!(result.text, "hello world");
        }
    }
}
