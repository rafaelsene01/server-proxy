# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy application files
# We copy package.json first to leverage Docker's cache if dependencies don't change
COPY package.json ./

# Since there are no dependencies in package.json, we can skip npm install.
# If you add dependencies later, uncomment the following line:
# RUN npm install

# Copy the rest of your application's code
COPY . .

# Make port 3131 available to the world outside this container
EXPOSE 3131

# Define the command to run the app
CMD ["node", "index.js"]
