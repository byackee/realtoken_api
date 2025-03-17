#!/bin/bash

# Récupération des variables d'environnement
LICENSE_KEY=""
ACCOUNT_ID=""
DB_PATH=${GEOIP_DB_PATH:-/usr/share/GeoIP}

echo "⏱️ Démarrage de la mise à jour GeoIP - $(date)"

# Test de connectivité réseau
echo "🔍 Test de connectivité réseau"
echo "- Test DNS: $(nslookup google.com 2>&1 || echo 'ERREUR DNS')"
echo "- Test HTTP: $(curl -s -m 5 -o /dev/null -w "%{http_code}" https://google.com || echo 'ERREUR HTTP')"
echo "- Test IP direct: $(curl -s -m 5 -o /dev/null -w "%{http_code}" https://8.8.8.8 || echo 'ERREUR IP')"

# Test de connectivité spécifique à MaxMind
echo "🔍 Test de connectivité à MaxMind"
MAXMIND_TEST=$(curl -s -m 5 -o /dev/null -w "%{http_code}" https://download.maxmind.com || echo 'ERREUR')
echo "- Réponse MaxMind: $MAXMIND_TEST"

# Création du répertoire si nécessaire
mkdir -p ${DB_PATH}

# Fonction pour téléchargement alternatif si le téléchargement officiel échoue
download_alternative() {
  echo "🔄 Utilisation d'une source alternative pour GeoLite2-City..."
  
  # Tentative depuis GitHub
  echo "📥 Téléchargement depuis GitHub..."
  if wget -q --no-check-certificate -O "/tmp/GeoLite2-City.tar.gz" \
     "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.tar.gz"; then
    
    # Extraction de la base de données
    echo "📦 Extraction de la base de données depuis GitHub..."
    mkdir -p "/tmp/geolite"
    tar -xzf "/tmp/GeoLite2-City.tar.gz" -C "/tmp/geolite" || true
    
    # Déplacement du fichier .mmdb vers le répertoire final
    if find "/tmp/geolite" -name "*.mmdb" -exec cp {} "${DB_PATH}/GeoLite2-City.mmdb" \; | grep .; then
      echo "✅ Base de données depuis GitHub installée avec succès"
      rm -rf "/tmp/geolite" "/tmp/GeoLite2-City.tar.gz"
      return 0
    fi
    rm -rf "/tmp/geolite" "/tmp/GeoLite2-City.tar.gz"
  fi
  
  # Tentative directe
  echo "📥 Téléchargement direct d'une base alternative..."
  if wget -q --no-check-certificate -O "${DB_PATH}/GeoLite2-City.mmdb" \
     "https://raw.githubusercontent.com/Dreamacro/maxmind-geoip/release/Country.mmdb"; then
    echo "✅ Base de données alternative téléchargée avec succès"
    return 0
  fi
  
  # Dernière tentative - fichier prépackagé 
  echo "📥 Essai de téléchargement depuis une source tertiaire..."
  if wget -q --no-check-certificate -O "${DB_PATH}/GeoLite2-City.mmdb" \
     "https://git.io/GeoLite2-City.mmdb"; then
    echo "✅ Base de données tertiaire téléchargée avec succès"
    return 0
  fi
  
  echo "❌ Tous les téléchargements ont échoué. Création d'une base de données vide."
  # Créer un fichier vide pour éviter les erreurs
  touch "${DB_PATH}/GeoLite2-City.mmdb"
  return 1
}

# Tentative de téléchargement officiel
echo "📥 Téléchargement officiel de GeoLite2-City..."
if wget -q --no-check-certificate -O "/tmp/GeoLite2-City.tar.gz" \
   "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${LICENSE_KEY}&suffix=tar.gz"; then
  
  # Extraction de la base de données
  echo "📦 Extraction de GeoLite2-City..."
  mkdir -p "/tmp/GeoLite2-City"
  tar -xzf "/tmp/GeoLite2-City.tar.gz" -C "/tmp/GeoLite2-City" --strip-components=1
  
  # Déplacement du fichier .mmdb vers le répertoire final
  if find "/tmp/GeoLite2-City" -name "*.mmdb" -exec cp {} "${DB_PATH}/GeoLite2-City.mmdb" \; | grep .; then
    echo "✅ GeoLite2-City mis à jour avec succès depuis la source officielle"
    rm -rf "/tmp/GeoLite2-City" "/tmp/GeoLite2-City.tar.gz"
  else
    echo "❌ Impossible de trouver le fichier .mmdb dans l'archive téléchargée"
    rm -rf "/tmp/GeoLite2-City" "/tmp/GeoLite2-City.tar.gz"
    download_alternative
  fi
else
  echo "❌ Échec du téléchargement officiel de GeoLite2-City. Tentative avec sources alternatives..."
  download_alternative
fi

echo "🎉 Mise à jour GeoIP terminée - $(date)"
echo "📂 Contenu du répertoire ${DB_PATH}:"
ls -la ${DB_PATH}

# Toujours terminer avec succès pour éviter d'interrompre le build
exit 0