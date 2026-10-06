//! The single host-version rule shared by the Claude and Codex adapters (ADR-0071).
//!
//! The qualified baseline is a minimum required version. Exactly the baseline is
//! `Qualified`; any well-formed version above it (newer patch, minor or major) is
//! accepted as `Untested`; anything below it or unparsable is rejected.

use crate::Compatibility;

/// Outcome of accepting an observed host version against a qualified baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostVersionStatus {
    /// Exactly the version the adapter was qualified against.
    Qualified,
    /// Newer than the baseline (patch, minor or major): accepted, but never verified.
    Untested,
}

impl HostVersionStatus {
    pub fn compatibility(self) -> Compatibility {
        match self {
            Self::Qualified => Compatibility::Compatible,
            Self::Untested => Compatibility::Untested,
        }
    }
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let mut next = || {
        let part = parts.next()?;
        (!part.is_empty()
            && part.len() <= 9
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part == "0" || !part.starts_with('0')))
        .then(|| part.parse::<u64>().ok())
        .flatten()
    };
    let parsed = (next()?, next()?, next()?);
    parts.next().is_none().then_some(parsed)
}

/// Classify `observed` against the minimum `baseline`; `None` means rejected
/// (older than the minimum, or an unparsable version).
pub fn classify_host_version(baseline: &str, observed: &str) -> Option<HostVersionStatus> {
    let (base, seen) = (parse(baseline)?, parse(observed)?);
    if seen < base {
        return None;
    }
    Some(if seen == base {
        HostVersionStatus::Qualified
    } else {
        HostVersionStatus::Untested
    })
}

/// Human-readable minimum requirement, e.g. `2.1.287 or newer`.
pub fn accepted_range(baseline: &str) -> String {
    format!("{baseline} or newer")
}

/// Owner-visible notice for an accepted but unverified version.
pub fn untested_notice(product: &str, observed: &str, baseline: &str) -> String {
    format!(
        "{product} {observed} is newer than the tested {baseline}; it should work, but has not been verified."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use HostVersionStatus::{Qualified, Untested};

    #[test]
    fn rule_table() {
        let table: &[(&str, Option<HostVersionStatus>)] = &[
            ("2.1.287", Some(Qualified)),
            ("2.1.288", Some(Untested)),
            ("2.1.289", Some(Untested)),
            ("2.1.1000", Some(Untested)),
            ("2.2.0", Some(Untested)),
            ("2.2.287", Some(Untested)),
            ("3.0.0", Some(Untested)),
            ("3.1.287", Some(Untested)),
            ("10.0.0", Some(Untested)),
            ("2.1.286", None),
            ("2.1.0", None),
            ("2.0.999", None),
            ("1.1.287", None),
            ("1.99.999", None),
            ("2.1", None),
            ("2.1.287.1", None),
            ("2.1.x", None),
            ("2.1.-1", None),
            ("2.1.+300", None),
            ("2.1.287-beta", None),
            ("2..300", None),
            ("", None),
            (" 2.1.300", None),
            ("garbage", None),
            ("2.1.99999999999999999999", None),
            ("02.1.287", None),
            ("2.01.287", None),
            ("2.1.0288", None),
            ("2.1.00", None),
        ];
        for (observed, expected) in table {
            assert_eq!(
                classify_host_version("2.1.287", observed),
                *expected,
                "{observed}"
            );
        }
        assert_eq!(classify_host_version("0.160.0", "0.160.0"), Some(Qualified));
        assert_eq!(classify_host_version("0.160.0", "0.160.1"), Some(Untested));
        assert_eq!(classify_host_version("0.160.0", "0.161.0"), Some(Untested));
        assert_eq!(classify_host_version("0.160.0", "1.0.0"), Some(Untested));
        assert_eq!(classify_host_version("0.160.0", "1.160.0"), Some(Untested));
        assert_eq!(classify_host_version("0.160.0", "0.159.9"), None);
        assert_eq!(classify_host_version("0.160.0", "0.159.99"), None);
    }

    #[test]
    fn notice_and_range_wording() {
        assert_eq!(
            untested_notice("Claude Code", "2.1.289", "2.1.287"),
            "Claude Code 2.1.289 is newer than the tested 2.1.287; it should work, but has not been verified."
        );
        assert_eq!(accepted_range("2.1.287"), "2.1.287 or newer");
        assert_eq!(Untested.compatibility(), Compatibility::Untested);
        assert_eq!(Qualified.compatibility(), Compatibility::Compatible);
    }
}
