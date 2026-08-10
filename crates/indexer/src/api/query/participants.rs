use sqlx::{Postgres, QueryBuilder};

use crate::models::ParticipantType;

enum ParticipantScopeMode {
    Include,
    Exclude,
}

pub fn attach_latest_participant_offers_scope<'a>(
    query_builder: &mut QueryBuilder<'a, Postgres>,
    participant_type: ParticipantType,
    script_pubkey: &'a [u8],
) {
    attach_participant_script_scope(
        query_builder,
        ParticipantScopeMode::Include,
        participant_type,
        std::iter::once(script_pubkey),
    );
}

pub fn attach_latest_participant_offers_scope_any<'a>(
    query_builder: &mut QueryBuilder<'a, Postgres>,
    participant_type: ParticipantType,
    script_pubkeys: &'a [Vec<u8>],
) {
    attach_participant_script_scope(
        query_builder,
        ParticipantScopeMode::Include,
        participant_type,
        script_pubkeys.iter().map(Vec::as_slice),
    );
}

pub fn attach_exclude_participant_script_scope<'a>(
    query_builder: &mut QueryBuilder<'a, Postgres>,
    participant_type: ParticipantType,
    script_pubkey: &'a [u8],
) {
    attach_participant_script_scope(
        query_builder,
        ParticipantScopeMode::Exclude,
        participant_type,
        std::iter::once(script_pubkey),
    );
}

fn attach_participant_script_scope<'a, I>(
    query_builder: &mut QueryBuilder<'a, Postgres>,
    mode: ParticipantScopeMode,
    participant_type: ParticipantType,
    script_pubkeys: I,
) where
    I: IntoIterator<Item = &'a [u8]>,
{
    match mode {
        ParticipantScopeMode::Include => {
            query_builder.push(" AND id IN (");
        }
        ParticipantScopeMode::Exclude => {
            query_builder.push(" AND id NOT IN (");
        }
    }
    query_builder.push(
        "SELECT offer_id FROM (
            SELECT DISTINCT ON (offer_id) offer_id, script_pubkey
            FROM offer_participants
            WHERE participant_type = ",
    );
    query_builder.push_bind(participant_type);
    query_builder.push(
        " ORDER BY offer_id, created_at_height DESC
        ) latest_participant WHERE script_pubkey IN (",
    );
    let mut separated = query_builder.separated(", ");
    for script_pubkey in script_pubkeys {
        separated.push_bind(script_pubkey);
    }
    separated.push_unseparated("))");
}

#[cfg(test)]
mod tests {
    use super::attach_latest_participant_offers_scope_any;
    use crate::models::ParticipantType;
    use sqlx::{Postgres, QueryBuilder};

    #[test]
    fn multi_script_scope_binds_every_script_in_one_latest_participant_query() {
        let scripts = vec![vec![0x52, 0xac], vec![0x53, 0xac]];
        let mut builder = QueryBuilder::<Postgres>::new("SELECT id FROM offers WHERE 1=1");

        attach_latest_participant_offers_scope_any(&mut builder, ParticipantType::Lender, &scripts);

        let sql = builder.sql();
        assert!(sql.contains("AND id IN (SELECT offer_id"));
        assert!(sql.contains("script_pubkey IN ($2, $3))"));
    }
}
