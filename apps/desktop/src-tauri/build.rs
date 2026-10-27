fn main() {
    // A generated constants file exists only for a white-label build; the
    // upstream build has no file and falls back to the literals in `brand.rs`.
    // `rustc-check-cfg` tells the compiler the name is one this crate defines,
    // so the `cfg` below is a known condition rather than a typo it warns about.
    println!("cargo::rustc-check-cfg=cfg(strata_brand_generated)");

    // Both halves have to notice a change: Rust recompiles when the constants
    // file moves, and the shell's config is merged by Tauri from the overlay
    // beside it.
    println!("cargo:rerun-if-changed=brand.generated.rs");
    println!("cargo:rerun-if-changed=brand.overlay.json");

    if std::path::Path::new("brand.generated.rs").is_file() {
        println!("cargo:rustc-cfg=strata_brand_generated");
    }

    tauri_build::build()
}
