FROM node:18-slim

# Install Java (OpenJDK) and other tools
RUN apt-get update && \
    apt-get install -y default-jdk wget unzip && \
    apt-get clean

# Install Apktool
RUN wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool -O /usr/local/bin/apktool && \
    chmod +x /usr/local/bin/apktool && \
    wget https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar -O /usr/local/bin/apktool.jar && \
    chmod +x /usr/local/bin/apktool.jar

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Create temp directory
RUN mkdir -p temp

EXPOSE 4000

CMD ["node", "server.js"]
