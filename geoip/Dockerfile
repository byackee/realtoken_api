FROM alpine:3.14

# Installation des dépendances
RUN apk add --no-cache wget curl unzip bash ca-certificates

# Création du répertoire pour les bases GeoIP
RUN mkdir -p /usr/share/GeoIP

# Copie du script de mise à jour
COPY update-geoip.sh /usr/local/bin/update-geoip.sh
RUN chmod +x /usr/local/bin/update-geoip.sh

# Variables d'environnement pour la configuration
ENV UPDATE_INTERVAL=7
ENV GEOIP_DB_PATH=/usr/share/GeoIP

# Exécution initiale du script de mise à jour
RUN /usr/local/bin/update-geoip.sh

# Configuration du cron pour les mises à jour automatiques
RUN echo "0 0 */${UPDATE_INTERVAL} * * /usr/local/bin/update-geoip.sh > /proc/1/fd/1 2>/proc/1/fd/2" > /etc/crontabs/root

# Volume pour partager les bases de données
VOLUME ["/usr/share/GeoIP"]

# Commande par défaut : exécute cron en premier plan
CMD ["crond", "-f", "-d", "8"]