-- Minimal fixture rows for `npm run verify:admin` on a throwaway CI database.
--
-- verify-admin-platform.ts needs one User, one non-archived Camp and one
-- non-archived Provider to exist before it inserts (and rolls back) its
-- trust/admin rows. CI applies this after `npm run db:migrate` against the
-- `services: postgres` container; it must never be applied to a real database.
INSERT INTO "User" (id, email, name)
VALUES ('ci-verify-user', 'ci-verify@example.com', 'CI Verify');

INSERT INTO "Provider" (id, slug, name)
VALUES ('ci-verify-provider', 'ci-verify-provider', 'CI Verify Provider');

INSERT INTO "Camp" (id, slug, name, "campType", category, "providerId")
VALUES ('ci-verify-camp', 'ci-verify-camp', 'CI Verify Camp', 'SUMMER_DAY', 'OTHER', 'ci-verify-provider');
