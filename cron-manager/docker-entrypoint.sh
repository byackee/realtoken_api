#!/bin/sh

# Créer les répertoires nécessaires s'ils n'existent pas
mkdir -p /app/scripts
mkdir -p /app/logs

# Informations de démarrage
echo "🔄 Initialisation du gestionnaire de tâches cron..."

# Copier les scripts d'exemple s'ils n'existent pas déjà
if [ ! -f "/app/scripts/example.js" ]; then
  echo "📄 Copie du script d'exemple example.js..."
  cp /app/scripts-examples/example.js /app/scripts/ 2>/dev/null || echo "⚠️ Le script example.js n'a pas pu être copié"
fi

if [ ! -f "/app/scripts/fetch_realt_tokens.js" ]; then
  echo "📄 Copie du script fetch_realt_tokens.js..."
  cp /app/scripts-examples/fetch_realt_tokens.js /app/scripts/ 2>/dev/null || echo "⚠️ Le script fetch_realt_tokens.js n'a pas pu être copié"
fi

if [ ! -f "/app/scripts/ethereum-example.js" ]; then
  echo "📄 Copie du script ethereum-example.js..."
  cp /app/scripts-examples/ethereum-example.js /app/scripts/ 2>/dev/null || echo "⚠️ Le script ethereum-example.js n'a pas pu être copié"
fi

if [ ! -f "/app/scripts/logging-example.js" ]; then
  echo "📄 Copie du script logging-example.js..."
  cp /app/scripts-examples/logging-example.js /app/scripts/ 2>/dev/null || echo "⚠️ Le script logging-example.js n'a pas pu être copié"
fi

# Créer un lien symbolique vers les modules node pour les scripts
echo "🔗 Création des liens vers les modules Node.js..."
mkdir -p /app/scripts/node_modules
ln -sf /usr/local/lib/node_modules/winston /app/scripts/node_modules/winston
ln -sf /usr/local/lib/node_modules/viem /app/scripts/node_modules/viem

# Modifier les permissions
echo "🔒 Configuration des permissions des scripts..."
chmod +x /app/scripts/*.js 2>/dev/null || echo "⚠️ Aucun script à rendre exécutable"

# Attendre que la base de données soit prête
echo "⏳ Attente de la base de données PostgreSQL (${DB_HOST})..."
until nc -z ${DB_HOST} ${DB_PORT:-5432}; do
  echo "⏳ PostgreSQL non disponible - attente..."
  sleep 2
done
echo "✅ PostgreSQL est disponible!"

# Message final avant de démarrer l'application
echo "🚀 Démarrage du gestionnaire de tâches cron..."

# Démarrer l'application
exec "$@" 