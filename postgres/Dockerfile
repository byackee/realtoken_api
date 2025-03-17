FROM postgres:15

# Copiez le script d'initialisation principal
COPY init-db.sh /docker-entrypoint-initdb.d/

# Copiez tous les scripts dans un répertoire temporaire
COPY scripts/ /tmp/scripts/

# Rendez les scripts exécutables
RUN chmod +x /docker-entrypoint-initdb.d/init-db.sh
RUN chmod +x /tmp/scripts/*.sh

