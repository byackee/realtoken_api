#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS transactions_history CASCADE;

    CREATE TABLE transactions_history (
        id SERIAL PRIMARY KEY,
        \"Transaction ID\" VARCHAR(255) NOT NULL,
        \"Token ID\" VARCHAR(255) NOT NULL,
        amount DECIMAL(20,4),
        sender VARCHAR(255),
        destination VARCHAR(255),
        timestamp VARCHAR(255),
        \"Transaction Hash\" VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(\"Transaction ID\")
    );

    -- Fonction de mise à jour automatique de updated_at
    CREATE OR REPLACE FUNCTION trigger_set_timestamp_transactions_history()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;

    -- Trigger pour mettre à jour updated_at à chaque modification
    CREATE TRIGGER set_timestamp_transactions_history
    BEFORE UPDATE ON transactions_history
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp_transactions_history();

    -- Index pour améliorer les performances des requêtes
    CREATE INDEX idx_transactions_history_transaction_id ON transactions_history(\"Transaction ID\");
    CREATE INDEX idx_transactions_history_destination ON transactions_history(destination);
    CREATE INDEX idx_transactions_history_token_id ON transactions_history(\"Token ID\");
" 