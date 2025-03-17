#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS user_accounts CASCADE;

    CREATE TABLE user_accounts (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        address VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, address)
    );

    -- Fonction de mise à jour automatique de updated_at
    CREATE OR REPLACE FUNCTION trigger_set_timestamp_user_accounts()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;

    -- Trigger pour mettre à jour updated_at à chaque modification
    CREATE TRIGGER set_timestamp_user_accounts
    BEFORE UPDATE ON user_accounts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp_user_accounts();

    -- Création des index pour optimiser les performances
    CREATE INDEX idx_user_accounts_user_id ON user_accounts(user_id);
    CREATE INDEX idx_user_accounts_address ON user_accounts(address);
" 