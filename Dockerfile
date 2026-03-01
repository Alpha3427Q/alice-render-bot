FROM node:18-slim

# Install git (required by npm for fetching some dependencies)
RUN apt-get update && \
    apt-get install -y git && \
    rm -rf /var/lib/apt/lists/*

# Setup App
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app (index.js, etc.)
COPY . .

# Run
CMD [ "node", "--expose-gc", "index.js" ]
