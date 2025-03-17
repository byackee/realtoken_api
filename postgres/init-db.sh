#!/bin/bash
set -e

# Création de la base de données realtoken
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "realtoken" WITH OWNER = "$POSTGRES_USER";
EOSQL

echo "Base de données realtoken créée!"

# Définir le mot de passe pour tous les scripts
export PGPASSWORD="$POSTGRES_PASSWORD"

# Copier les scripts dans un répertoire avec les bonnes permissions
mkdir -p /tmp/scripts_exec
cp /tmp/scripts/add_*.sh /tmp/scripts_exec/
chmod -R 777 /tmp/scripts_exec/

# Lister les fichiers disponibles
echo "Fichiers à exécuter:"
ls -la /tmp/scripts_exec/

# Attendre que PostgreSQL soit complètement prêt
until pg_isready; do
  echo "Attente du démarrage complet de PostgreSQL..."
  sleep 2
done

# Exécution de tous les scripts bash
for script in $(ls -1 /tmp/scripts_exec/add_*.sh | sort); do
    echo "Exécution du script: $script"
    
    # Modifier le script pour utiliser le socket Unix
    sed -i 's/-h postgres//g' "$script"
    
    # Exécuter le script
    bash "$script"
    
    echo "Script $script exécuté avec succès"
done

echo "Tous les scripts ont été exécutés"