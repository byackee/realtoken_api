#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS address_list CASCADE;

    CREATE TABLE address_list (
        id SERIAL PRIMARY KEY,
        address VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Fonction de mise à jour automatique de updated_at
    CREATE OR REPLACE FUNCTION trigger_set_timestamp_address_list()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;

    -- Trigger pour mettre à jour updated_at à chaque modification
    CREATE TRIGGER set_timestamp_address_list
    BEFORE UPDATE ON address_list
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp_address_list();
"