FROM node:20-alpine

WORKDIR /app

# Installer les dépendances système nécessaires
RUN apk add --no-cache bash curl netcat-openbsd

# Installer les modules globalement pour qu'ils soient accessibles aux scripts
RUN npm install -g winston@latest viem@latest cron-parser@latest

# Copier les fichiers package.json et package-lock.json
COPY package*.json ./

# Installer les dépendances
RUN npm install
# S'assurer que viem et winston sont bien installés localement aussi
RUN npm install viem@latest winston@latest prom-client@latest --save
# S'assurer que express est bien installé
RUN npm install express --save

# Créer les répertoires nécessaires
RUN mkdir -p /app/scripts /app/scripts-examples /app/logs

# Copier les scripts d'exemple
COPY scripts/*.js /app/scripts-examples/

# Copier le reste des fichiers de l'application
COPY . .

# Créer un lien symbolique vers le répertoire scripts à la racine
RUN ln -s /app/scripts /app/scripts

# Rendre le script d'entrée exécutable
RUN chmod +x /app/docker-entrypoint.sh

# Exposer les ports
EXPOSE 3000
# Port pour les métriques Prometheus (normalement servi sur la même port 3000 mais /metrics)
EXPOSE 9091

# Labels pour Prometheus
LABEL prometheus.scrape="true"
LABEL prometheus.port="3000"
LABEL prometheus.path="/metrics"

# Définir les variables d'environnement
ENV NODE_ENV=production \
    DB_HOST=postgres \
    DB_USER=nocodb \
    DB_PASSWORD=nocodbpassword \
    DB_NAME=nocodb \
    DB_PORT=5432 \
    SCRIPTS_PATH=/app/scripts \
    LOGS_DIR=/app/logs \
    STARTUP_DELAY=10000 \
    NODE_PATH=/usr/local/lib/node_modules

# Script d'entrée Docker
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Commande pour démarrer l'application
CMD ["node", "server.js"] 