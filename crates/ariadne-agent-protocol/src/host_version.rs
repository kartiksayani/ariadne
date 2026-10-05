//! The single host-version rule shared by the Claude and Codex adapters (ADR-0071).
//!
//! A qualified baseline stays pinned. The same major.minor with a patch at or
//! above the baseline is accepted as `Untested`; anything else is rejected.

use crate::Compatibility;

/// Outcome of accepting an observed host version against a qualified baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostVersionStatus {
    /// Exactly the version the adapter was qualified against.
    Qualified,
    /// Same major.minor, newer patch: accepted, but never verified.
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
        (!part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse::<u64>().ok())
            .flatten()
    };
    let parsed = (next()?, next()?, next()?);
    parts.next().is_none().then_some(parsed)
}

/// Classify `observed` against `baseline`; `None` means rejected (different
/// major or minor, older patch, or an unparsable version).
pub fn classify_host_version(baseline: &str, observed: &str) -> Option<HostVersionStatus> {
    let (base, seen) = (parse(baseline)?, parse(observed)?);
    if (base.0, base.1) != (seen.0, seen.1) || seen.2 < base.2 {
        return None;
    }
    Some(if seen == base {
        HostVersionStatus::Qualified
    } else {
        HostVersionStatus::Untested
    })
}

/// Human-readable accepted range, e.g. `2.1.287 or a newer 2.1.x patch`.
pub fn accepted_range(baseline: &str) -> String {
    match parse(baseline) {
        Some((major, minor, _)) => format!("{baseline} or a newer {major}.{minor}.x patch"),
        None => baseline.to_owned(),
    }
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
            ("2.1.286", None),
            ("2.1.0", None),
            ("2.2.287", None),
            ("2.0.999", None),
            ("3.1.287", None),
            ("1.1.287", None),
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
        assert_eq!(classify_host_version("0.160.0", "0.161.0"), None);
        assert_eq!(classify_host_version("0.160.0", "1.160.0"), None);
    }

    #[test]
    fn notice_and_range_wording() {
        assert_eq!(
            untested_notice("Claude Code", "2.1.289", "2.1.287"),
            "Claude Code 2.1.289 is newer than the tested 2.1.287; it should work, but has not been verified."
        );
        assert_eq!(accepted_range("2.1.287"), "2.1.287 or a newer 2.1.x patch");
        assert_eq!(Untested.compatibility(), Compatibility::Untested);
        assert_eq!(Qualified.compatibility(), Compatibility::Compatible);
    }
}
