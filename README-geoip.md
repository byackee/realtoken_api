# Géolocalisation des requêtes API

Ce module ajoute une fonctionnalité de géolocalisation à votre API FastAPI, permettant de visualiser d'où proviennent les requêtes entrantes via Grafana.

## Composants ajoutés

1. **Collecte de données de géolocalisation** via la bibliothèque GeoIP2 de MaxMind
2. **Stockage des données** dans une nouvelle table PostgreSQL
3. **Métriques Prometheus** pour la visualisation
4. **Tableau de bord Grafana** pour l'analyse des données

## Installation

Le système est automatiquement configuré lors du démarrage des containers Docker. La base de données GeoLite2 est téléchargée et installée dans le conteneur FastAPI.

### Configuration de la base de données GeoIP

**Note importante:** Dans l'environnement de production, il est recommandé d'utiliser une licence MaxMind valide pour obtenir une base de données GeoIP2 à jour. La version actuelle utilise une source publique qui peut ne pas être toujours disponible ou à jour.

Pour utiliser une licence MaxMind officielle, modifiez le Dockerfile FastAPI avec vos informations d'identification.

## Utilisation des données de géolocalisation

### API Endpoints

Deux nouveaux endpoints ont été ajoutés à l'API:

- **GET /ip_geolocation** - Permet de récupérer les données brutes de géolocalisation
- **GET /ip_geolocation_stats** - Fournit des statistiques agrégées sur les données de géolocalisation

### Visualisation dans Grafana

1. Accédez à Grafana via l'URL: http://localhost:3000
2. Connectez-vous avec les identifiants par défaut (admin/admin)
3. Importez le tableau de bord de géolocalisation depuis le fichier JSON:
   - Dans Grafana, cliquez sur "+ Import" dans le menu latéral
   - Téléchargez ou copiez-collez le contenu du fichier `grafana-geolocation-dashboard.json`
   - Sélectionnez Prometheus comme source de données
   - Cliquez sur "Import"

### Métriques disponibles

Les métriques suivantes sont exposées à Prometheus:

- `country_requests_total` - Compteur de requêtes par pays
- `city_requests_total` - Compteur de requêtes par ville
- `latitude_requests` - Latitude des requêtes
- `longitude_requests` - Longitude des requêtes

## Personnalisation

### Ajout de visualisations supplémentaires

Si vous souhaitez ajouter d'autres visualisations à Grafana:

1. Créez un nouveau panel dans le tableau de bord
2. Utilisez les métriques `country_requests_total`, `city_requests_total`, `latitude_requests` et `longitude_requests`
3. Filtrez les données selon vos besoins

### Modification de la rétention des données

Par défaut, toutes les données de géolocalisation sont stockées indéfiniment dans la base de données PostgreSQL. Pour modifier ce comportement:

1. Créez un job cron pour nettoyer les anciennes données
2. Ou ajoutez une politique de rétention directement dans PostgreSQL

```sql
-- Exemple: Supprime les données de plus de 30 jours
DELETE FROM ip_geolocation WHERE timestamp < NOW() - INTERVAL '30 days';
```