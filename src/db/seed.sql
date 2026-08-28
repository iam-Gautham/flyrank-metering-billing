-- Seed initial plans (Free and Pro)
-- Free Plan: 1,000 monthly API calls, 100,000 monthly tokens, $0.00
-- Pro Plan: 50,000 monthly API calls, 5,000,000 monthly tokens, $29.00 (2900 cents)
INSERT INTO plans (name, monthly_api_limit, monthly_token_limit, price_cents)
VALUES 
    ('Free', 1000, 100000, 0),
    ('Pro', 50000, 5000000, 2900)
ON CONFLICT (name) DO UPDATE SET
    monthly_api_limit = EXCLUDED.monthly_api_limit,
    monthly_token_limit = EXCLUDED.monthly_token_limit,
    price_cents = EXCLUDED.price_cents;

-- Seed Development Demo Tenant
INSERT INTO tenants (name)
SELECT 'Demo Tenant'
WHERE NOT EXISTS (
    SELECT 1 FROM tenants WHERE name = 'Demo Tenant'
);
