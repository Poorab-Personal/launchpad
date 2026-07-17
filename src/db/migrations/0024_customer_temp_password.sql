-- Add temp_password to customers — the temporary sign-in password actually
-- sent to the customer. Pre-filled from the customer's name (or platform
-- email local-part) but editable by the Account Creator in the Send
-- Credentials panel, then persisted here at send time. The four password
-- surfaces (Send Credentials panel, credentials email, portal Sign In task,
-- portal Handy page) read this value back via resolveTempPassword so they
-- all match what actually went out. Nullable: null until credentials are
-- sent; still temporary (customer resets on first Rejig sign-in).

ALTER TABLE "customers" ADD COLUMN "temp_password" text;
