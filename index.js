const AWS = require("aws-sdk")
const s3 = new AWS.S3()
const documentClient = new AWS.DynamoDB.DocumentClient()
const dbbTables = {
    "chats": "eatluh-chats",
    "shops": "eatluh-shops",
    "users": "eatluh-users"
}

const TG = require('node-telegram-bot-api')
const telegramBot = new TG(process.env.TELEGRAM_TOKEN);

const https = require('https')

function between(min, max) {  
    return Math.floor(
        Math.random() * (max - min + 1) + min
    )
}

function getRequest(url) {

  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let rawData = '';

      res.on('data', chunk => {
        rawData += chunk;
      });

      res.on('end', () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (err) {
          reject(new Error(err));
        }
      });
    });

    req.on('error', err => {
      reject(new Error(err));
    });
  });
  
}

async function sendQuote(chatRoom){

    let quotesData =  await s3.getObject({Bucket: 'eatluh.whyys.xyz',Key: process.env.S3_QUOTESLIB}).promise();
    let quotesDataRows = quotesData.Body.toString().split(/\r?\n/);
    let quotesRow = between(0, quotesDataRows.length - 1) 
    let reply = quotesDataRows[quotesRow]
    
    await telegramBot.sendMessage(chatRoom, reply).catch((error) => {
        console.log(error.code);  // => 'ETELEGRAM'
        console.log(error.response.body); // => { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
    })
    
    return true;
        
}

async function saveShop(thisShop){
    let ids = thisShop.position.lat +'/'+ thisShop.position.lon +'/'+ thisShop.poi.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    let brand = (thisShop.poi.brands) ? thisShop.poi.brands[0].name : thisShop.poi.name;
    let cate = (thisShop.poi.categories) ? thisShop.poi.categories[0] : '-';
    let postal = (thisShop.address.extendedPostalCode) ? thisShop.address.extendedPostalCode : thisShop.address.postalCode;
    let shopParam = {
        "TableName": dbbTables.shops,
        "Item": {
            "ids": `${ids}`, 
            "brand_coy": `${thisShop.poi.name}`,
            "brand": `${brand}`, 
            "category": `${cate}`, 
            "map_position": thisShop.position.lat +','+ thisShop.position.lon,
            "map_address": thisShop.address.freeformAddress,
            "map_postal": `${postal}`, 
            "map_area": `${thisShop.address.municipalitySubdivision}`, 
        }
    }
    return await documentClient.put(shopParam, (err)=>{
        if(err){
            console.log('Storing to DB FAIL', err)
        }
        else {
            //console.log('Stored DB')
        }
    }).promise()
}

exports.handler = async (event) => {
    
    let correctContent = "";
    
    // TODO implement
    console.log(event)
 
    let data = JSON.parse(event.body)
    if(data.message && data.message.chat){
        
        let t = +new Date()
        let chatRoom = data.message.chat.id;
        let chatPerson = data.message.chat.first_name;
        let chatTime = data.message.date

        let userProfile
        var findUserParams = {
          TableName : dbbTables.users,
          Key: {
            ids: `${chatRoom}`
          }
        };
        await documentClient.get(findUserParams, function(err, data) {
            if (err) 
                console.log(err);
            else {
                if (data.Item)
                    userProfile = data.Item
                else
                    userProfile = {
                        "ids": `${chatRoom}`, 
                        "name": `${chatPerson}`,
                        "join_timestamp": chatTime,
                        "loc_area": "-",
                        "last_location": 0,
                        "last_search": 0,
                        "last_answer": 0,
                        "last_chat": chatTime
                    }
            }
        }).promise();
        console.log('userProfile',userProfile)
        
        let msgType = 'TEXT';
        let msgContent = data.message.text
        if (data.message.location){
            
            let mapUrl = "https://atlas.microsoft.com/search/poi/json?api-version=1.0&query=food&limit=35&radius=100000"
            mapUrl += "&subscription-key=" + process.env.AZURE_KEY
            mapUrl += "&lat=" + data.message.location.latitude
            mapUrl += "&lon=" + data.message.location.longitude
            
            msgType = 'LOCATION'
            msgContent = mapUrl
            
            // Get POI from Azure
            let specialReply = "";
            let shopsData = await getRequest(mapUrl);
            if (shopsData.results) {
                correctContent += "Looks like there's something nearby...\n\n"
                for(var i=0; i<shopsData.results.length; i++){
                    saveShop(shopsData.results[i])
                    correctContent += "- <code>" + shopsData.results[i].poi.name + "</code> \n"
                    
                }
                correctContent += "\nAny of this sounds interesting? Copy & paste the shop name to me and I can give you more info..."
                
                userProfile.loc_area = shopsData.results[0].address.municipalitySubdivision
                userProfile.last_location = chatTime
            }
            
        }
        
        if (msgType == 'TEXT' && msgContent == '/start') {
            msgType = 'START'
            correctContent = "Hey " + chatPerson + ", where are you? Send me your location lah!"
        }
        
        if (msgType == 'TEXT' && msgContent && msgContent != "") {
            // Maybe it is a shop name? 
            var findShopParam = {
              TableName : dbbTables.shops,
              FilterExpression : 'brand = :str or brand_coy = :str',
              ExpressionAttributeValues : {
                  ':str' : msgContent
              }
            };
            await documentClient.scan(findShopParam, function(err, data) {
                if (err) {
                    console.log(err)
                }
                if (data && data.Count > 0){
                    msgType = 'SEARCH';
                    let shop = data.Items[0];
                    
                    correctContent = shop.brand
                    if (shop.brand != shop.brand_coy)
                        correctContent+= " (aka " + shop.brand_coy +")"
                    correctContent+= "\nis a <i>"+ shop.category +"</i>"
                    correctContent+= " in " + shop.map_area + ".\n\n"
                    correctContent+= "<code>"+ shop.map_address +"</code> \n"
                    correctContent+= '<a href="https://maps.google.com/?q='+ shop.map_position +'">Open Map</a>'
                    
                    userProfile.last_search = chatTime
                }
            }).promise();


        }
        
        let contentParam = {
            "TableName": dbbTables.chats,
            "Item": {
                "ids": `${t}` + '-' + `${chatRoom}`,
                "chat_id": `${chatRoom}`,
                "name": `${chatPerson}`,
                "content": `${msgContent}`, 
                "chat_time": chatTime,
                "msg_type": `${msgType}`
            }
        }
        console.log('Storing to DB', contentParam, data.message)
        await documentClient.put(contentParam, (err)=>{
            if(err){
                console.log('Storing to DB FAIL', err)
            }
            else {
                //console.log('Stored DB')
            }
        }).promise()
        
        
        if (correctContent!="") {
            // Send the reply
            await telegramBot.sendMessage(chatRoom, correctContent, {"parse_mode":"HTML",disable_web_page_preview:true})
        }
        else {
            // Got no content... say something stupid
            var scanPar = {
              TableName: dbbTables.chats,
              IndexName: 'IDX002',
              KeyConditionExpression: 'chat_id = :hkey and chat_time > :rkey',
              ExpressionAttributeValues: {
                ':hkey': `${chatRoom}`,
                ':rkey': chatTime - 300,
                //':stype': 'TEXT'
              }
            }; 
            var msgLast5Min = 0;
            await documentClient.query(scanPar, function(err, data) {
                if (err) {
                    console.log('err',err);
                }
                else {
                    if (data.Items){
                        for(var i=0; i<data.Items.length; i++) {
                            if (data.Items[i].msg_type == "TEXT")
                                msgLast5Min++;
                        }
                    } 
                } 
            }).promise() 
            if (msgLast5Min < 2) {
                await telegramBot.sendMessage(chatRoom, 'Hey there, I\'m still not that confident of my recommendations, so.. may I interest you with a sarcastic comment instead...')
                await new Promise(resolve => setTimeout(resolve, 1500));
            }        
            
            // Reply randomly uhh
            await sendQuote(chatRoom);
        }
        

        // Save user profile & action
        let userParam = {
            "TableName": dbbTables.users,
            "Item": userProfile
        }
        await documentClient.put(userParam, (err)=>{
            if(err){
                console.log('Storing to DB FAIL', err)
            }
            else {
                //console.log('Stored DB')
            }
        }).promise()
        
    }
        

    const response = {
        statusCode: 200,
        body: JSON.stringify('Thank you BotFather <3'),
    };
    return response;
};
