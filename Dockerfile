# Use official Node.js LTS lightweight Alpine image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Set default Node environment
ENV NODE_ENV=production

# Copy dependency definition files
COPY package*.json ./

# Install only production dependencies cleanly
RUN npm ci --omit=dev

# Copy the rest of the application files
COPY --chown=node:node . .

# Expose the API port (default 5001)
EXPOSE 5001

# Run container as non-root user for security
USER node

# Start the server
CMD ["npm", "start"]
