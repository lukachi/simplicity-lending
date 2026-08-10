use serde::Deserialize;

use crate::api::ApiError;
use crate::api::params::OfferFilters;
use crate::api::utils::parse_script_pubkey;

pub const MAX_LENDER_SCRIPT_PUBKEYS: usize = 64;

/// One legacy script or a comma-separated set of rotating lender scripts.
#[derive(Deserialize, Debug, Default)]
pub struct LenderScriptQuery {
    pub script_pubkey: Option<String>,
    pub script_pubkeys: Option<String>,
}

impl LenderScriptQuery {
    pub fn parse(&self) -> Result<Vec<Vec<u8>>, ApiError> {
        let mut scripts = Vec::new();
        if let Some(script) = self.script_pubkey.as_deref() {
            scripts.push(parse_script_pubkey(script)?);
        }
        if let Some(script_set) = self.script_pubkeys.as_deref() {
            for script in script_set.split(',') {
                if script.trim().is_empty() {
                    return Err(ApiError::BadRequest(
                        "script_pubkeys must not contain empty values".to_string(),
                    ));
                }
                scripts.push(parse_script_pubkey(script)?);
            }
        }
        scripts.sort();
        scripts.dedup();
        if scripts.is_empty() {
            return Err(ApiError::BadRequest(
                "script_pubkey or script_pubkeys is required".to_string(),
            ));
        }
        if scripts.len() > MAX_LENDER_SCRIPT_PUBKEYS {
            return Err(ApiError::BadRequest(format!(
                "At most {MAX_LENDER_SCRIPT_PUBKEYS} lender script pubkeys are allowed"
            )));
        }
        Ok(scripts)
    }
}

/// Query parameters for `GET /lenders/overview`.
pub type LenderOverviewQuery = LenderScriptQuery;

/// Query parameters for `GET /lenders/offers`: wallet script plus offer-list filters.
#[derive(Deserialize, Debug)]
pub struct LenderOffersQuery {
    #[serde(flatten)]
    pub scripts: LenderScriptQuery,
    #[serde(flatten)]
    pub filters: OfferFilters,
}

#[cfg(test)]
mod tests {
    use super::LenderOffersQuery;

    #[test]
    fn lender_offers_query_parses_flat_pagination() {
        let parsed: LenderOffersQuery = serde_urlencoded::from_str(
            "script_pubkey=0014d0c4a3ef09e887b6e99e397e518fe3e41a118ca1&limit=10",
        )
        .expect("parse lender offers query");

        assert_eq!(
            parsed.scripts.script_pubkey.as_deref(),
            Some("0014d0c4a3ef09e887b6e99e397e518fe3e41a118ca1")
        );
        assert_eq!(parsed.filters.limit, Some(10));
    }

    #[test]
    fn lender_script_query_accepts_and_deduplicates_rotating_scripts() {
        let parsed: LenderOffersQuery =
            serde_urlencoded::from_str("script_pubkeys=53ac%2C52ac%2C53ac&limit=10")
                .expect("parse lender scripts");

        assert_eq!(
            parsed.scripts.parse().expect("valid scripts"),
            vec![vec![0x52, 0xac], vec![0x53, 0xac]]
        );
    }

    #[test]
    fn lender_script_query_requires_at_least_one_script() {
        let parsed: LenderOffersQuery = serde_urlencoded::from_str("limit=10").expect("parse");
        assert!(parsed.scripts.parse().is_err());
    }
}
