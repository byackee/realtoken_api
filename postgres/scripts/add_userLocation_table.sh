#!/bin/bash

export PGPASSWORD="nocodbpassword"

# Création de la table user_location_logs
psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS user_location_logs CASCADE;

"

# Création de la fonction trigger pour la mise à jour du timestamp
psql -h postgres -U nocodb -d realtoken -c "
    CREATE OR REPLACE FUNCTION trigger_set_timestamp()
    RETURNS TRIGGER AS 
    \$\$
    BEGIN
        NEW.accessed_at = NOW();
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;
"

# Ajout du trigger pour mettre à jour accessed_at à chaque modification
psql -h postgres -U nocodb -d realtoken -c "
    CREATE TRIGGER set_timestamp
    BEFORE UPDATE ON user_location_logs
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp();
"

echo "✅ La table user_location_logs a été créée avec succès et le trigger est en place !"
