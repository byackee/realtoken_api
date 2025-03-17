#!/bin/sh
set -e

echo "🚀 Démarrage du service GeoIP..."

# Démarrage du service cron en arrière-plan
echo "⏱️ Démarrage du service cron..."
crond -b -l 8

# Exécution initiale pour s'assurer que les bases sont à jour
echo "🔄 Mise à jour initiale des bases GeoIP..."
/usr/local/bin/update-geoip.sh

echo "✅ GeoIP service démarré avec succès!"
echo "📂 Contenu du répertoire GeoIP:"
ls -la ${GEOIP_DB_PATH}

# Garder le conteneur en vie
echo "🔄 Service en fonctionnement, attente des mises à jour programmées..."
while true; do
    sleep 3600 # Dormir pendant 1 heure
    echo "💓 Service GeoIP actif, bases disponibles dans ${GEOIP_DB_PATH}"
done 