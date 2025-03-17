# Utilisation de Python 3.9 slim comme base
FROM python:3.9-slim

# Définition du répertoire de travail
WORKDIR /app

# Mise à jour des paquets et installation de Node.js 18.x et dépendances supplémentaires
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Vérification des versions installées (optionnel)
RUN node -v && npm -v

# Installation de node-fetch@2 globalement
RUN npm install -g node-fetch@2

# Copie des fichiers de dépendances d'abord
COPY package.json package-lock.json* /app/

# Installation des dépendances Node.js
RUN npm install

# Copie des fichiers Python et installation des dépendances FastAPI
COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# Installation de la bibliothèque geoip2
RUN pip install --no-cache-dir geoip2

# Copie du reste du projet
COPY . /app

# Commande pour démarrer FastAPI avec Uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--proxy-headers"]
