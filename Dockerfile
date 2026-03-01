FROM node:18-slim

# Setup App
WORKDIR /usr/src/app

COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app (index.js, etc.)
COPY . .

# Run
CMD [ "node", "index.js" ]
