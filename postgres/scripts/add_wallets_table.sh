#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS token_balances CASCADE;

    CREATE TABLE token_balances (
        id SERIAL PRIMARY KEY,
        wallet VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL,
        amount DECIMAL(12,4),
        type VARCHAR(255) NOT NULL DEFAULT 'wallet',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Fonction de mise à jour automatique de updated_at
    CREATE OR REPLACE FUNCTION trigger_set_timestamp_token_balances()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;

    -- Trigger pour mettre à jour updated_at à chaque modification
    CREATE TRIGGER set_timestamp_token_balances
    BEFORE UPDATE ON token_balances
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp_token_balances();
"