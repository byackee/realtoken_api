from fastapi import FastAPI, HTTPException, Request
from urllib.parse import quote
import httpx
import os
import subprocess
import re
import asyncpg
import datetime
import dateutil.parser
import traceback
import asyncio  # Nécessaire pour asyncio.sleep

# Variables de connexion PostgreSQL
DB_HOST = "postgres"
DB_NAME = "realtoken"
DB_USER = "nocodb"
DB_PASSWORD = "nocodbpassword"

# ----------------------------
# Intégration de slowapi
# ----------------------------
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# ----------------------------
# Ajout de la géolocalisation
# ----------------------------
import geoip2.database
from geoip2.errors import AddressNotFoundError
import ipaddress
from prometheus_client import Counter, Gauge

# Chemin vers la base de données MaxMind GeoLite2 depuis la variable d'environnement
GEOIP_DB_PATH = os.getenv("GEOIP_DB_PATH", "/app/GeoLite2-City.mmdb")

# Compteurs Prometheus pour la géolocalisation
COUNTRY_REQUESTS = Counter('country_requests_total', 'Total requests by country', ['country_code', 'country_name'])
CITY_REQUESTS = Counter('city_requests_total', 'Total requests by city', ['city_name', 'country_code'])
LATITUDE_REQUESTS = Gauge('latitude_requests', 'Latitude of requests', ['ip', 'endpoint'])
LONGITUDE_REQUESTS = Gauge('longitude_requests', 'Longitude of requests', ['ip', 'endpoint'])

# ----------------------------
# Intégration de Prometheus pour FastAPI
# ----------------------------
from prometheus_fastapi_instrumentator import Instrumentator

app = FastAPI()

from fastapi.middleware.cors import CORSMiddleware

# Configuration CORS
origins = [
    "https://realtoken-community.github.io",  # Domaine de ton frontend Flutter
    "http://localhost:*",  # Tous les ports de localhost pour le développement
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if "http://localhost:*" not in origins else [
        origin for origin in origins if origin != "http://localhost:*"
    ] + ["http://localhost:" + str(port) for port in range(1024, 65536)],
    allow_credentials=True,
    allow_methods=["*"],  # Autorise toutes les méthodes HTTP
    allow_headers=["*"],  # Autorise tous les headers HTTP
)

# Configuration de slowapi
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Configuration de Prometheus
instrumentator = Instrumentator()
instrumentator.instrument(app).expose(app)

# ----------------------------
# Chemins des scripts Node.js
# ----------------------------
NODE_SCRIPT_WALLETBALANCE = "/app/fetch_wallet_balances.js"
NODE_SCRIPT_RMMBALANCE = "/app/fetch_rmmbalance_gnosis.js"
NODE_SCRIPT_REALTOKEN = "/app/fetch_realt_tokens.js"
NODE_SCRIPT_TOKENSVOLUME = "/app/fetch_tokens_volume.js"
NODE_SCRIPT_YAM_TRANSACTIONS = "/app/fetch_YAM_transactions_history.js"  # Nouveau script de synchronisation des transactions
NODE_SCRIPT_FETCH_USER_ADDRESSES = "/app/fetch_userId_addresses.js"
NODE_SCRIPT_TRANSACTIONS_HISTORY = "/app/fetch_transactions_history.js"

# ----------------------------
# Durée minimale entre deux exécutions (en secondes)
# ----------------------------
MIN_INTERVAL = 900

# ----------------------------
# Création de la table de géolocalisation au démarrage
# ----------------------------
async def create_geolocation_table():
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )
        
        # Vérifier si la table existe déjà
        table_exists = await conn.fetchval(
            "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ip_geolocation')"
        )
        
        if table_exists:
            # Si la table existe, modifier la colonne country_code pour augmenter sa taille
            try:
                await conn.execute('''
                ALTER TABLE ip_geolocation 
                ALTER COLUMN country_code TYPE VARCHAR(10)
                ''')
                print("✅ Table ip_geolocation modifiée : country_code augmenté à VARCHAR(10)")
            except Exception as e:
                print(f"⚠️ Modification de la colonne country_code impossible: {str(e)}")
        else:
            # Créer la table avec la bonne taille pour country_code
            await conn.execute('''
            CREATE TABLE IF NOT EXISTS ip_geolocation (
                id SERIAL PRIMARY KEY,
                ip VARCHAR(45) NOT NULL,
                country_code VARCHAR(10),
                country_name VARCHAR(255),
                city VARCHAR(255),
                latitude DECIMAL(9,6),
                longitude DECIMAL(9,6),
                endpoint VARCHAR(255),
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
            ''')
            print("✅ Table de géolocalisation IP créée avec succès")
        
        await conn.close()
    except Exception as e:
        print(f"❌ Erreur lors de la création/modification de la table de géolocalisation: {str(e)}")

# Fonction pour extraire l'adresse IP réelle du client
def get_client_ip(request: Request):
    # Vérifier les en-têtes communs pour l'IP d'origine
    if "X-Forwarded-For" in request.headers:
        # X-Forwarded-For peut contenir plusieurs IPs (client, proxy1, proxy2, ...)
        # Format: "client, proxy1, proxy2, ..."
        # On prend la première IP qui est celle du client d'origine
        return request.headers["X-Forwarded-For"].split(",")[0].strip()
    elif "X-Real-IP" in request.headers:
        return request.headers["X-Real-IP"]
    elif "CF-Connecting-IP" in request.headers:  # Pour Cloudflare
        return request.headers["CF-Connecting-IP"]
    
    # Si aucun en-tête spécifique n'est présent, utiliser l'IP de la connexion
    return request.client.host

# Fonction pour la géolocalisation des adresses IP
def get_ip_geolocation(ip_address):
    try:
        # Ignorer les adresses IP locales
        if ipaddress.ip_address(ip_address).is_private:
            return {
                "country_code": "LO",  # Abréviation pour LOCAL
                "country_name": "Local Network",
                "city": "Local",
                "latitude": 0,
                "longitude": 0
            }
        
        # Vérifier si le fichier GeoIP existe
        if not os.path.exists(GEOIP_DB_PATH) or os.path.getsize(GEOIP_DB_PATH) < 1000:
            print(f"⚠️ Base de données GeoIP manquante ou vide à {GEOIP_DB_PATH}")
            return {
                "country_code": "XX",
                "country_name": "GeoIP Database Missing",
                "city": "Unknown",
                "latitude": 0,
                "longitude": 0
            }
            
        reader = geoip2.database.Reader(GEOIP_DB_PATH)
        response = reader.city(ip_address)
        
        # Normaliser le code pays pour s'assurer qu'il ne dépasse pas 10 caractères
        country_code = response.country.iso_code
        if not country_code:
            country_code = "UN"  # Abréviation pour UNKNOWN
        elif len(country_code) > 10:
            country_code = country_code[:10]
            
        geolocation = {
            "country_code": country_code,
            "country_name": response.country.name or "Unknown",
            "city": response.city.name or "Unknown",
            "latitude": response.location.latitude or 0,
            "longitude": response.location.longitude or 0
        }
        
        reader.close()
        return geolocation
    except FileNotFoundError:
        print(f"⚠️ Base de données GeoIP non trouvée à {GEOIP_DB_PATH}")
        return {
            "country_code": "XX",
            "country_name": "Database Missing",
            "city": "Unknown",
            "latitude": 0,
            "longitude": 0
        }
    except AddressNotFoundError:
        print(f"⚠️ Adresse IP non trouvée dans la base GeoIP: {ip_address}")
        return {
            "country_code": "XX",  
            "country_name": "Unknown Location",
            "city": "Unknown",
            "latitude": 0,
            "longitude": 0
        }
    except Exception as e:
        print(f"⚠️ Erreur lors de la géolocalisation de l'IP: {str(e)}")
        return {
            "country_code": "XX",
            "country_name": "Error",
            "city": "Error",
            "latitude": 0,
            "longitude": 0
        }

# Fonction pour enregistrer la géolocalisation en base de données
async def save_geolocation(ip_address, endpoint, geolocation):
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )
        
        await conn.execute('''
        INSERT INTO ip_geolocation 
        (ip, country_code, country_name, city, latitude, longitude, endpoint)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ''',
        ip_address,
        geolocation["country_code"],
        geolocation["country_name"],
        geolocation["city"],
        geolocation["latitude"],
        geolocation["longitude"],
        endpoint
        )
        
        await conn.close()
    except Exception as e:
        print(f"⚠️ Erreur lors de l'enregistrement de la géolocalisation: {str(e)}")
        # Ne pas lever d'exception pour éviter de bloquer la route

# ------------------------------------------------------------------------------
# Middleware de géolocation
# ------------------------------------------------------------------------------
@app.middleware("http")
async def geolocation_middleware(request: Request, call_next):
    # Récupérer le chemin de l'endpoint
    endpoint = request.url.path
    
    # Ignorer les requêtes vers /metrics (Prometheus)
    if endpoint == "/metrics":
        return await call_next(request)
    
    try:
        # Récupérer l'adresse IP réelle du client
        ip_address = get_client_ip(request)
        
        # Obtenir les informations de géolocalisation
        geolocation = get_ip_geolocation(ip_address)
        
        # Incrémenter les compteurs Prometheus - Gérer les erreurs pour éviter de bloquer
        try:
            COUNTRY_REQUESTS.labels(
                country_code=geolocation["country_code"],
                country_name=geolocation["country_name"]
            ).inc()
            
            CITY_REQUESTS.labels(
                city_name=geolocation["city"],
                country_code=geolocation["country_code"]
            ).inc()
            
            # Mettre à jour les jauges de latitude et longitude
            LATITUDE_REQUESTS.labels(
                ip=ip_address,
                endpoint=endpoint
            ).set(geolocation["latitude"])
            
            LONGITUDE_REQUESTS.labels(
                ip=ip_address,
                endpoint=endpoint
            ).set(geolocation["longitude"])
        except Exception as e:
            print(f"⚠️ Erreur lors de la mise à jour des métriques Prometheus: {str(e)}")
        
        # Enregistrer en base de données - ne bloque pas en cas d'erreur
        await save_geolocation(ip_address, endpoint, geolocation)
    except Exception as e:
        print(f"⚠️ Erreur dans le middleware de géolocalisation: {str(e)}")
        # Ne pas bloquer la route en cas d'erreur dans le middleware
    
    # Continuer le traitement de la requête quoi qu'il arrive
    return await call_next(request)

# ------------------------------------------------------------------------------
# Middleware de gestion globale des exceptions
# ------------------------------------------------------------------------------
@app.middleware("http")
async def catch_exceptions_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        print("❌ ERREUR DÉTECTÉE :", traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

# ----------------------------
# Démarrage de l'application
# ----------------------------
@app.on_event("startup")
async def startup():
    try:
        await create_geolocation_table()
        print("✅ Table de géolocalisation vérifiée avec succès")
    except Exception as e:
        print(f"⚠️ Erreur lors de la création/vérification de la table de géolocalisation: {str(e)}")
        print("⚠️ L'API fonctionnera mais la géolocalisation pourrait ne pas être disponible")
    
    # Vérifier la disponibilité de la base GeoIP
    if not os.path.exists(GEOIP_DB_PATH):
        print(f"⚠️ Base de données GeoIP non trouvée à {GEOIP_DB_PATH}")
        print("⚠️ La géolocalisation des adresses IP ne sera pas précise")
    elif os.path.getsize(GEOIP_DB_PATH) < 1000:
        print(f"⚠️ Base de données GeoIP à {GEOIP_DB_PATH} est vide ou corrompue")
        print("⚠️ La géolocalisation des adresses IP ne sera pas précise")
    else:
        try:
            # Test rapide de la base GeoIP
            reader = geoip2.database.Reader(GEOIP_DB_PATH)
            test_ip = "8.8.8.8"  # IP de Google DNS
            response = reader.city(test_ip)
            reader.close()
            print(f"✅ Base de données GeoIP fonctionnelle ({os.path.getsize(GEOIP_DB_PATH)/1024/1024:.2f} MB)")
        except Exception as e:
            print(f"⚠️ Erreur lors du test de la base GeoIP: {str(e)}")
            print("⚠️ La géolocalisation des adresses IP pourrait ne pas fonctionner correctement")
    
    print("🚀 Application démarrée avec succès")

async def fetch_records_postgres(table: str, where_clause: str = None, limit: int = 1000):
    """
    Récupère des enregistrements directement depuis PostgreSQL avec gestion des erreurs et logs.
    """
    try:
        print(f"🟢 Connexion à PostgreSQL pour récupérer les enregistrements de la table '{table}'")

        # Connexion PostgreSQL
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Construction de la requête SQL
        query = f'SELECT * FROM "{table}"'
        params = []

        if where_clause:
            query += f" WHERE {where_clause}"

        query += f" LIMIT {limit}"

        print(f"🔍 Requête SQL exécutée : {query}")

        # Exécution de la requête
        rows = await conn.fetch(query, *params)

        # Fermeture de la connexion
        await conn.close()

        if not rows:
            print(f"⚠️ Aucun enregistrement trouvé dans '{table}' avec '{where_clause}'")

        # Conversion des résultats en dictionnaire
        records = [dict(row) for row in rows]

        return records

    except asyncpg.exceptions.PostgresError as e:
        print("❌ ERREUR PostgreSQL :", e)
        raise HTTPException(status_code=500, detail="Erreur PostgreSQL lors de la récupération des données")
    except Exception as e:
        print("❌ ERREUR Inconnue :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des données")

async def get_last_execution_time(request_id: str):
    try:
        print(f"🔍 Recherche du dernier timestamp pour : {request_id}")

        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Récupérer l'enregistrement avec les bons noms de champs
        record = await conn.fetchrow(
            'SELECT updated_at FROM last_executions WHERE request = $1',
            request_id
        )

        if not record:
            print(f"⚠️ Aucun enregistrement trouvé pour {request_id}")
            return None

        last_exec_time = record['updated_at']
        print(f"🟢 Dernière exécution trouvée : {last_exec_time}")

        # Convertir la date en UTC avec timezone
        if last_exec_time.tzinfo is None:
            last_exec_time = last_exec_time.replace(tzinfo=datetime.timezone.utc)

        return last_exec_time

    except asyncpg.exceptions.PostgresError as e:
        print("❌ ERREUR PostgreSQL :", e)
        raise HTTPException(status_code=500, detail="Erreur PostgreSQL lors de la récupération du timestamp")
    except Exception as e:
        print("❌ ERREUR Inconnue :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération du timestamp")
    finally:
        await conn.close()
        
async def update_execution_time(request_id: str):
    """
    Met à jour ou insère un timestamp dans la table last_executions.
    """
    try:
        print(f"🔄 Mise à jour de l'exécution pour : {request_id}")
        # Créer une date UTC sans timezone pour PostgreSQL
        now = datetime.datetime.utcnow()

        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Vérifier si l'enregistrement existe déjà
        exists = await conn.fetchval(
            'SELECT EXISTS(SELECT 1 FROM last_executions WHERE request = $1)',
            request_id
        )

        if exists:
            print(f"📡 Mise à jour de l'enregistrement existant")
            await conn.execute(
                'UPDATE last_executions SET updated_at = $1 WHERE request = $2',
                now, request_id
            )
        else:
            print("✅ Aucun enregistrement trouvé, création d'un nouvel enregistrement")
            await conn.execute(
                'INSERT INTO last_executions (request, created_at, updated_at) VALUES ($1, $2, $3)',
                request_id, now, now
            )

    except Exception as e:
        print("❌ ERREUR lors de la mise à jour du timestamp :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la mise à jour du timestamp")
    finally:
        await conn.close()

def run_node_script(script_path: str, arg: str = None):
    """
    Exécute le script Node.js.
    Si un argument est fourni, il sera passé au script.
    """
    try:
        command = ["node", script_path]
        if arg is not None:
            command.append(arg)
            print(f"✅ Script '{script_path}' exécuté avec succès avec argument")
        else:
            print(f"✅ Script '{script_path}' exécuté avec succès sans argument")
        subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:
        print(f"❌ Erreur lors de l'exécution du script {script_path} : {str(e)}")
        raise HTTPException(status_code=500, detail=f"Erreur lors de l'exécution du script {script_path}")

def is_valid_ethereum_address(address: str) -> bool:
    return bool(re.fullmatch(r"^0x[a-fA-F0-9]{40}$", address))

async def check_and_run(request_id: str, script_path: str, arg: str):
    """
    Vérifie si le dernier lancement identifié par 'request_id' date de plus de MIN_INTERVAL.
    Si c'est le cas, exécute le script et met à jour le timestamp.
    """
    print(f"🔍 Vérification de la dernière exécution pour '{request_id}'")
    last_exec = await get_last_execution_time(request_id)

    if last_exec is None:
        print(f"✅ Aucune exécution antérieure détectée pour '{request_id}'")
    else:
        utc_now = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc)

        # ✅ Correction : S'assurer que last_exec est bien "offset-aware"
        if last_exec.tzinfo is None:
            last_exec = last_exec.replace(tzinfo=datetime.timezone.utc)

        elapsed = (utc_now - last_exec).total_seconds()
        print(f"⏳ Dernière exécution il y a {elapsed / 60:.1f} minutes")

    if (last_exec is None) or (elapsed >= MIN_INTERVAL):
        print(f"🚀 Exécution du script '{script_path}'")
        run_node_script(script_path, arg)
        await update_execution_time(request_id)
    else:
        print("⏸ Exécution ignorée : intervalle minimal non respecté")

async def run_node_script_async(script_path: str, arg: str = None):
    """
    Exécute le script Node.js de manière asynchrone et attend sa complétion.
    Si un argument est fourni, il sera passé au script.
    """
    try:
        command = ["node", script_path]
        if arg is not None:
            command.append(arg)
        print(f"🚀 Lancement du script : {' '.join(command)}")
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            error_message = stderr.decode().strip()
            print(f"❌ Erreur lors de l'exécution du script {script_path}")
            raise HTTPException(status_code=500, detail=f"Erreur d'exécution du script {script_path}")
        else:
            print("✅ Script terminé avec succès")
    except Exception as e:
        print(f"❌ Exception lors de l'exécution du script {script_path} : {str(e)}")
        raise HTTPException(status_code=500, detail=f"Erreur lors de l'exécution du script {script_path}")

async def ensure_wallet_exists_and_sync(wallet_address: str, script_type: str = "wallet"):
    if not is_valid_ethereum_address(wallet_address):
        raise HTTPException(status_code=400, detail="Adresse Ethereum invalide")

    try:
        # Connexion à PostgreSQL
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Vérifier si le wallet existe
        wallet_exists = await conn.fetchval(
            'SELECT EXISTS(SELECT 1 FROM address_list WHERE address = $1)',
            wallet_address.lower()
        )
        
        # Définition de l'ID de synchronisation selon le type de script
        if script_type == "wallet":
            sync_request_id = "wallet_tokens"
        elif script_type == "yam":
            sync_request_id = "yam_transactions"
        elif script_type == "transactionsHistory":
            sync_request_id = "transactions_history"
        else:
            raise ValueError(f"script_type '{script_type}' non supporté")

        if not wallet_exists:
            # Insérer le nouveau wallet
            await conn.execute(
                'INSERT INTO address_list (address) VALUES ($1)',
                wallet_address.lower()
            )
            print(f"🆕 Nouveau wallet détecté, synchronisation immédiate")
            if script_type == "wallet":
                await run_node_script_async(NODE_SCRIPT_WALLETBALANCE)
                await run_node_script_async(NODE_SCRIPT_RMMBALANCE)
            elif script_type == "yam":
                await run_node_script_async(NODE_SCRIPT_YAM_TRANSACTIONS)
            elif script_type == "transactionsHistory":
                await run_node_script_async(NODE_SCRIPT_TRANSACTIONS_HISTORY, wallet_address)
            await update_execution_time(sync_request_id)
            return {"status": "success", "message": f"Nouveau wallet ajouté et synchronisé"}
        else:
            print("✅ Wallet existant trouvé, aucune synchronisation nécessaire")
            return {"status": "success", "message": f"Wallet existant, aucune synchronisation lancée"}

    except Exception as e:
        print("❌ ERREUR lors de la vérification du wallet :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la vérification du wallet")
    finally:
        await conn.close()

# ------------------------------------------------------------------------------
# Endpoints de l'API
# ------------------------------------------------------------------------------

@app.get("/" , include_in_schema=False)
@limiter.limit("10/minute")
async def root(request: Request):
    return {"message": "Bienvenue sur l'API FastAPI avec NocoDB"}

@app.get("/list_realtokens/")
@limiter.limit("5/minute")
async def list_realtokens(request: Request):
    # Ne plus lancer automatiquement le script
    # await check_and_run("list_realtokens", NODE_SCRIPT_REALTOKEN, "list_realtokens")
    return await fetch_records_postgres("real_tokens")  # Nom de la table PostgreSQL à adapter

@app.get("/wallet_userId/{wallet_address}")
@limiter.limit("5/minute")
async def wallet_userid(request: Request, wallet_address: str):
    if not is_valid_ethereum_address(wallet_address):
        print("❌ Adresse Ethereum invalide fournie")
        raise HTTPException(status_code=400, detail="Adresse Ethereum invalide")

    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Vérifier si l'adresse existe dans user_accounts
        address_exists = await conn.fetchval(
            'SELECT EXISTS(SELECT 1 FROM user_accounts WHERE address = $1)',
            wallet_address.lower()
        )

        # Si l'adresse n'existe pas, lancer la synchronisation
        if not address_exists:
            print("🆕 Nouvelle adresse détectée, synchronisation immédiate")
            await run_node_script_async(NODE_SCRIPT_FETCH_USER_ADDRESSES, wallet_address)
            print("✅ Synchronisation terminée")
        else:
            print("✅ Adresse existante trouvée, pas de synchronisation nécessaire")

        # Récupérer le userId pour l'adresse donnée
        user_data = await conn.fetchrow(
            'SELECT user_id FROM user_accounts WHERE address = $1',
            wallet_address.lower()
        )

        if not user_data:
            print("⚠️ Aucun userId trouvé")
            return {"status": "not_found", "message": "Aucun userId trouvé pour cette adresse"}

        user_id = user_data['user_id']
        if not user_id:
            print("⚠️ UserId non présent dans la réponse")
            return {"status": "error", "message": "Aucun userId associé"}

        print("✅ UserId trouvé")
        
        # Récupérer toutes les adresses associées au userId
        addresses_data = await conn.fetch(
            'SELECT address FROM user_accounts WHERE user_id = $1',
            user_id
        )

        if not addresses_data:
            print("⚠️ Aucune adresse associée trouvée")
            return {"status": "not_found", "message": "Aucune adresse trouvée pour ce userId"}

        addresses = [record['address'] for record in addresses_data]
        print(f"✅ {len(addresses)} adresse(s) trouvée(s) pour ce userId")

        return {
            "status": "success",
            "userId": user_id,
            "addresses": addresses
        }

    except Exception as e:
        print("❌ ERREUR lors de la récupération des données :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des données")
    finally:
        await conn.close()

@app.get("/wallet_tokens/")
@limiter.limit("5/minute")
async def list_wallettokens(request: Request):
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch('SELECT * FROM token_balances')
        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération des tokens :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des tokens")
    finally:
        await conn.close()

@app.get("/wallet_tokens/{wallet_address}")
@limiter.limit("5/minute")
async def list_wallet_tokens(request: Request, wallet_address: str):
    if not is_valid_ethereum_address(wallet_address):
        print("❌ Adresse Ethereum invalide fournie")
        raise HTTPException(status_code=400, detail="Adresse Ethereum invalide")

    print("🔄 Vérification et synchronisation du wallet")
    await ensure_wallet_exists_and_sync(wallet_address, script_type="wallet")
    print("✅ Synchronisation terminée")

    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch(
            'SELECT * FROM token_balances WHERE wallet = $1',
            wallet_address.lower()
        )

        if not records:
            print("⚠️ Aucune donnée disponible")
            return []

        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération des tokens :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des tokens")
    finally:
        await conn.close()

@app.get("/tokens_volume/")
@limiter.limit("5/minute")
async def list_token_volume_days(request: Request, days: int = 30):
    # Ne plus lancer automatiquement le script
    # await check_and_run("tokens_volume", NODE_SCRIPT_TOKENSVOLUME, "sync_token_volume_days")
    
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch(
            '''
            SELECT * FROM token_volumes 
            WHERE date >= NOW() - make_interval(days => $1)
            ORDER BY date DESC
            ''',
            days
        )

        if not records:
            print("⚠️ Aucune donnée trouvée")
            return []

        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération des volumes :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des volumes")
    finally:
        await conn.close()

@app.get("/YAM_transactions_history/{wallet_address}")
@limiter.limit("5/minute")
async def yam_transactions_history(request: Request, wallet_address: str):
    if not is_valid_ethereum_address(wallet_address):
        print("❌ Adresse Ethereum invalide fournie")
        raise HTTPException(status_code=400, detail="Adresse Ethereum invalide")

    print("🔄 Vérification et synchronisation du wallet")
    await ensure_wallet_exists_and_sync(wallet_address, script_type="yam")
    print("✅ Synchronisation terminée")

    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch(
            'SELECT * FROM yam_transactions_history WHERE account_id = $1',
            wallet_address.lower()
        )

        if not records:
            print("⚠️ Aucune donnée disponible")
            return []

        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération de l'historique YAM :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération de l'historique YAM")
    finally:
        await conn.close()

@app.get("/transactions_history/{wallet_address}")
@limiter.limit("5/minute")
async def transactions_history(request: Request, wallet_address: str):
    if not is_valid_ethereum_address(wallet_address):
        print("❌ Adresse Ethereum invalide fournie")
        raise HTTPException(status_code=400, detail="Adresse Ethereum invalide")

    print("🔄 Vérification et synchronisation du wallet")
    await ensure_wallet_exists_and_sync(wallet_address, script_type="transactionsHistory")
    print("✅ Synchronisation terminée")

    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch(
            'SELECT * FROM transactions_history WHERE destination = $1',
            wallet_address.lower()
        )

        if not records:
            print("⚠️ Aucune donnée disponible")
            return []

        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération de l'historique des transactions :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération de l'historique des transactions")
    finally:
        await conn.close()

@app.get("/last_refresh/")
@limiter.limit("5/minute")
async def last_refresh(request: Request):
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch('SELECT * FROM last_executions')
        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération des dernières actualisations :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des dernières actualisations")
    finally:
        await conn.close()

@app.get("/ip_geolocation" , include_in_schema=False)
@limiter.limit("5/minute")
async def get_ip_geolocation_data(request: Request, limit: int = 1000):
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        records = await conn.fetch(
            '''
            SELECT * FROM ip_geolocation
            ORDER BY timestamp DESC
            LIMIT $1
            ''',
            limit
        )

        if not records:
            print("⚠️ Aucune donnée de géolocalisation disponible")
            return []

        return [dict(record) for record in records]

    except Exception as e:
        print("❌ ERREUR lors de la récupération des données de géolocalisation :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des données de géolocalisation")
    finally:
        await conn.close()

@app.get("/ip_geolocation_stats" , include_in_schema=False)
@limiter.limit("5/minute")
async def get_ip_geolocation_stats(request: Request):
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Statistiques par pays
        country_stats = await conn.fetch(
            '''
            SELECT country_code, country_name, COUNT(*) as total_requests
            FROM ip_geolocation
            GROUP BY country_code, country_name
            ORDER BY total_requests DESC
            '''
        )

        # Statistiques par endpoint
        endpoint_stats = await conn.fetch(
            '''
            SELECT endpoint, COUNT(*) as total_requests
            FROM ip_geolocation
            GROUP BY endpoint
            ORDER BY total_requests DESC
            '''
        )

        # Statistiques par heure de la journée
        hourly_stats = await conn.fetch(
            '''
            SELECT EXTRACT(HOUR FROM timestamp) as hour, COUNT(*) as total_requests
            FROM ip_geolocation
            GROUP BY hour
            ORDER BY hour
            '''
        )

        return {
            "country_stats": [dict(record) for record in country_stats],
            "endpoint_stats": [dict(record) for record in endpoint_stats],
            "hourly_stats": [dict(record) for record in hourly_stats],
        }

    except Exception as e:
        print("❌ ERREUR lors de la récupération des statistiques de géolocalisation :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors de la récupération des statistiques de géolocalisation")
    finally:
        await conn.close()

@app.get("/admin/clean_metrics_geolocation" , include_in_schema=False)
@limiter.limit("5/minute")
async def clean_metrics_geolocation(request: Request):
    """
    Endpoint administratif pour supprimer les entrées /metrics de la table de géolocalisation.
    """
    try:
        conn = await asyncpg.connect(
            host=DB_HOST,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )

        # Supprimer les entrées /metrics
        delete_result = await conn.execute(
            '''
            DELETE FROM ip_geolocation
            WHERE endpoint = '/metrics'
            '''
        )

        # Extraction du nombre de lignes supprimées
        rows_deleted = int(delete_result.split(" ")[1])
        
        print(f"✅ {rows_deleted} entrées /metrics supprimées de la table ip_geolocation")
        
        return {
            "status": "success", 
            "message": f"{rows_deleted} entrées /metrics supprimées avec succès"
        }

    except Exception as e:
        print("❌ ERREUR lors du nettoyage des données de métriques :", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Erreur lors du nettoyage des données de métriques")
    finally:
        await conn.close()
