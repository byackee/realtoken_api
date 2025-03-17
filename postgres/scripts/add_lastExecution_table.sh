#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS last_executions CASCADE;

    CREATE TABLE last_executions (
        id SERIAL PRIMARY KEY,
        request VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
"

psql -h postgres -U nocodb -d realtoken -c "
    CREATE OR REPLACE FUNCTION trigger_set_timestamp()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;
"

psql -h postgres -U nocodb -d realtoken -c "
    CREATE TRIGGER set_timestamp
    BEFORE UPDATE ON last_executions
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp();
"