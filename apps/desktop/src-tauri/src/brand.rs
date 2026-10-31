// What this build calls itself, for the code that cannot read the config.
//
// A white-label build is the same program with a different name, a different
// bundle id, and a different place to keep its data. Tauri reads `productName`
// and `identifier` from the config at build time, and `scripts/brand.ts` merges
// a generated overlay into it; this module is the same answer for the Rust code,
// which needs the data directory and the source link.
//
// `scripts/brand.ts` writes `../brand.generated.rs` next to this file — plain
// constants, so there is nothing to parse and no dependency to add. One
// resolution, two consumers: the window title and the folder the app keeps its
// database in cannot disagree.
//
// The generated file is git-ignored. A checkout that has never built carries the
// upstream values from the `include!` fallback below, which is what makes
// `cargo test` work without a preceding `bun run brand`.

#[cfg(not(strata_brand_generated))]
mod generated {
    pub const PRODUCT_NAME: &str = "Agent Strata";
    pub const IDENTIFIER: &str = "me.pbeta.agent-strata";
    pub const DATA_DIR: &str = ".agent-strata";
    pub const SOURCE_URL: &str = "https://github.com/atbeta/agent-strata";
    pub const SOURCE_LABEL: &str = "atbeta/agent-strata";
}

#[cfg(strata_brand_generated)]
mod generated {
    include!("../brand.generated.rs");
}

/// What a build carries.
///
/// `data_dir` is the field Rust acts on. The rest are the answer the page and
/// the config already have — `scripts/brand.ts` writes them for Tauri and Vite —
/// and they are here so a diagnostic that wants to name the build does not have
/// to ask the frontend for its own name. Hence `dead_code`: the fields are read,
/// just not by this crate.
#[allow(dead_code)]
pub struct Brand {
    pub product_name: &'static str,
    pub identifier: &'static str,
    /// The folder under the home directory: `~/.agent-strata` upstream.
    pub data_dir: &'static str,
    pub source_url: &'static str,
    pub source_label: &'static str,
}

/// The brand this build carries.
///
pub const fn get() -> Brand {
    Brand {
        product_name: generated::PRODUCT_NAME,
        identifier: generated::IDENTIFIER,
        data_dir: generated::DATA_DIR,
        source_url: generated::SOURCE_URL,
        source_label: generated::SOURCE_LABEL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_brand_always_answers() {
        // Whatever the generated file holds, the app cannot start without a
        // name and a folder. The defaults above guarantee both, so this holds
        // for a build that ran `bun run brand` and for one that did not.
        let brand = get();
        assert!(!brand.product_name.is_empty());
        assert!(!brand.identifier.is_empty());
        assert!(
            brand.data_dir.starts_with('.'),
            "the data directory is a dotfolder: {}",
            brand.data_dir
        );
        // source_url may be empty: a build can keep the About sentence and draw
        // no link. The name and the folder are the fields a start requires.
    }
}
