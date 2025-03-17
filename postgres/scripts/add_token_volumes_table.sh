#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS token_volumes CASCADE;

    CREATE TABLE token_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        quantity DECIMAL(20,4),
        volume DECIMAL(20,4),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
    );

    -- Fonction de mise à jour automatique de updated_at
    CREATE OR REPLACE FUNCTION trigger_set_timestamp_token_volumes()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;

    -- Trigger pour mettre à jour updated_at à chaque modification
    CREATE TRIGGER set_timestamp_token_volumes
    BEFORE UPDATE ON token_volumes
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp_token_volumes();

    -- Index pour améliorer les performances des requêtes
    CREATE INDEX idx_token_volumes_token ON token_volumes(token);
    CREATE INDEX idx_token_volumes_date ON token_volumes(date);
" 