use std::path::{Path, PathBuf};
use std::process::Command;

fn run_fetch_script(manifest_dir: &Path, script_path: &Path) -> bool {
    let root_dir = manifest_dir.join("..");
    let status = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", "bun", "run"])
            .arg(script_path)
            .current_dir(&root_dir)
            .status()
    } else {
        Command::new("bun")
            .arg("run")
            .arg(script_path)
            .current_dir(&root_dir)
            .status()
    };

    match status {
        Ok(st) => st.success(),
        Err(_) => false,
    }
}

fn ensure_pdfium_binary(manifest_dir: &Path) {
    let bin_dir = manifest_dir.join("bin");
    let _ = std::fs::create_dir_all(&bin_dir);

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let expected_file = match target_os.as_str() {
        "windows" => "pdfium.dll",
        "macos" => "libpdfium.dylib",
        _ => "libpdfium.so",
    };

    let target_path = bin_dir.join(expected_file);
    if !target_path.exists() {
        let script_path = manifest_dir.join("..").join("scripts").join("fetch-pdfium.ts");
        let mut fetched = false;

        if script_path.exists() {
            println!("cargo:warning=[build.rs] Fetching PDFium binary for {target_os} via bun...");
            if run_fetch_script(manifest_dir, &script_path) && target_path.exists() {
                fetched = true;
                println!("cargo:warning=[build.rs] Successfully fetched PDFium binary to {:?}", target_path);
            }
        }

        // If fetch could not run or failed, provide a placeholder file so the
        // tauri.conf.json bundle resource glob "bin/*" does not panic during build.
        if !fetched && !target_path.exists() {
            let placeholder = bin_dir.join(".placeholder");
            let _ = std::fs::write(&placeholder, "PDFium placeholder for tauri bundle resource glob\n");
            let placeholder_visible = bin_dir.join("placeholder.txt");
            let _ = std::fs::write(&placeholder_visible, "PDFium placeholder for tauri bundle resource glob\n");
            println!(
                "cargo:warning=[build.rs] PDFium binary '{}' was not found in {:?}. Run 'bun run scripts/fetch-pdfium.ts' to enable native PDF rendering.",
                expected_file, bin_dir
            );
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    ensure_pdfium_binary(&manifest_dir);
    tauri_build::build()
}
