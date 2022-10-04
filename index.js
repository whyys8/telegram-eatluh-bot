const AWS = require("aws-sdk")
const s3 = new AWS.S3()
const lambda = new AWS.Lambda();
const sqs = new AWS.SQS({apiVersion: '2012-11-05'});
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

function saveQueue(url){
    var params = { 
      MessageAttributes: {},
      MessageBody: url, 
      QueueUrl: process.env.SQS_QUEUEURL
    };
    
    return sqs.sendMessage(params, function(err, data) {
      if (err) {
        console.log("Error", err);
      } else {
        console.log("Success", data.MessageId);
      }
    }).promise();
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

async function sendDefaultReply(chatRoom, newChat = false, msg=''){
    
    
    // Check if you have blog content about nearby shops?
    let sentiment = '';
     
    var params = {
        FunctionName: 'awsintegrate-sentiment', // the lambda function we are going to invoke
        InvocationType: 'RequestResponse',
        LogType: 'Tail',
        Payload: '{ "msg" : "'+msg+'" }'
    };
    await lambda.invoke(params, function(err, data) {
        if (err) {
            console.log(err)
        } else {
            sentiment = JSON.parse(data.Payload); 
        }
    }).promise();
    
    console.log("sentiment", sentiment)
    if (sentiment.sentiment == 'NEGATIVE') {
        //await telegramBot.sendMessage(chatRoom, 'Hey, OMG! That attitude is uncalled for. Let\'s try again with a more polite tone..', {"parse_mode":"HTML"}) 
        // let sticker = process.env.S3_ASSETSURL + 'eatluh/slaps.webp'
        // await telegramBot.sendSticker(chatRoom, sticker);
        
        let sticker = process.env.S3_ASSETSURL + 'eatluh/slaps.gif'
        await telegramBot.sendAnimation(chatRoom, sticker);
        
        await telegramBot.sendMessage(chatRoom, 'That attitude is uncalled for!');
        return;
    }
    
    
    if (newChat){
        await telegramBot.sendMessage(chatRoom, 'Hey there, <b><u>share with me your location</u></b> now so I know how to help you.', {"parse_mode":"HTML"});
        
        await telegramBot.sendMessage(chatRoom, 'Whatever that you\'ve just said, I cannot understand and can\'t give any constructive reply yet, so.. may I interest you with a sarcastic comment instead...', {"parse_mode":"HTML"})
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
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
                if (data.Item) {
                    userProfile = data.Item
                }
                else {
                    userProfile = {
                        "ids": `${chatRoom}`, 
                        "name": `${chatPerson}`,
                        "join_timestamp": chatTime,
                        "loc_area": "-",
                        "loc_position": "-",
                        "last_postal": "-",
                        "last_location": 0,
                        "last_search": 0,
                        "last_answer": 0,
                        "last_chat": chatTime
                    }
                }
            }
        }).promise();
        console.log('userProfile',userProfile)
        
        let msgType = 'TEXT';
        let msgContent = data.message.text
        if (data.message.location){
            
            let mapUrl = "https://atlas.microsoft.com/search/poi/json?api-version=1.0&query=food&limit=35&radius=100000"
            mapUrl += "&subscription-key=" + process.env.AZURE_KEY
            mapUrl += "&lat=" + data.message.location.latitude + "&lon=" + data.message.location.longitude;
            
            msgType = 'LOCATION'
            msgContent = mapUrl
            
            // Get POI from Azure
            let postal = "";
            let specialReply = "";
            let shopsData = await getRequest(mapUrl);
            if (shopsData.results) {
                
                let streetName = shopsData.results[0].address.streetName;
                postal = (shopsData.results[0].address.extendedPostalCode) ? shopsData.results[0].address.extendedPostalCode : shopsData.results[0].address.postalCode;
                
                // Default message and save shops around here to DDB
                userProfile.last_resp_type = 'MAP_SHOP';
                userProfile.last_postal = postal;
                correctContent = "You're at "+streetName+" ("+postal+"). I found some shops nearby...\n\n"
                for(var i=0; i<shopsData.results.length; i++){
                    saveShop(shopsData.results[i])
                    correctContent += "- <code>" + shopsData.results[i].poi.name + "</code> \n"
                    
                }
                correctContent += "\nAny of this sounds interesting? Copy & paste the shop name to me and I can give you more info..."
                
                
                // Check if you have blog content about nearby shops?
                var params = {
                    FunctionName: 'eatluh-location', // the lambda function we are going to invoke
                    InvocationType: 'RequestResponse',
                    LogType: 'Tail',
                    Payload: '{ "postal" : "'+postal+'" }'
                };
                await lambda.invoke(params, function(err, data) {
                    if (err) {
                        console.log(err)
                    } else {
                        let blogs = JSON.parse(data.Payload);
                        console.log('Blogs '+blogs.length+': '+ blogs);
                        
                        if (blogs.length > 0){
                            userProfile.last_resp_type = 'MAP_BLOG'
                            correctContent = "You're at "+streetName+" ("+postal+"). People have blogged about...\n\n"
                            
                            for(var i=0; i<blogs.length && i<15; i++){ 
                                correctContent += "- <a href='" + blogs[i].url + "'>" + blogs[i].title + "</a> \n"
                            }
                            
                            correctContent += "\nOr you can give me some keywords (i.e. chicken rice, waffles, mala tang, etc) and I'll suggest something else.."
                        }
                    }
                }).promise();
                
                userProfile.loc_position = data.message.location.latitude +","+ data.message.location.longitude
                userProfile.loc_area = shopsData.results[0].address.municipalitySubdivision
                userProfile.last_location = chatTime
            }
            
            
            
        }
        
        if (msgType == 'TEXT' && msgContent == '/start') {
            msgType = 'START'
            correctContent = "Hey " + chatPerson + ", where are you? Share your location with me and I tell you want to eat!"
        }
        
        if (msgType == 'TEXT' && msgContent == '/help') {
            msgType = 'START'
            correctContent = "To get started, share with me your location by dropping the location pin in this chat.\n\n"
            correctContent+= "I will try to find articles written by local food bloggers of any restaurants, cafes and food stores in the area. The articles that features shops nearer to your current location will be ranked higher.\n\n"
            correctContent+= "If I cannot find any articles that features places near you, I'll show you a list of food stores I get from the map. Send me the store name and I can give you more details and location to it.\n\n"
            correctContent+= "Other than that, if you are sending me nonsense, then don't blame me for being sarcastic. "
        }
        
        if (msgType == 'TEXT' && msgContent && msgContent.substring(0,8) == "https://") {
            let first_space = (msgContent.indexOf(' ') > 0) ? msgContent.indexOf(' ') : msgContent.length;
            let extract_url = msgContent.substring(0, first_space);
            console.log('Queued '+ extract_url +' from '+ msgContent)
            await saveQueue(msgContent);
            correctContent = "Thanks " + chatPerson + "! I'll read about it later."
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
        
        if (correctContent == "" && msgType == 'TEXT' && msgContent && msgContent != "") { 
            if (userProfile.loc_position && userProfile.loc_position != "-" && userProfile.last_location > (chatTime - 900)){
                // ASK GOOGLE
                var params = {
                    FunctionName: 'eatluh-askgmap', // the lambda function we are going to invoke
                    InvocationType: 'RequestResponse',
                    LogType: 'Tail',
                    Payload: '{ "latlong" : "'+userProfile.loc_position+'", "postal": "'+userProfile.last_postal+'", "query": "'+msgContent+'" }'
                };
                await lambda.invoke(params, function(err, data) {
                    if (err) {
                        console.log(err)
                    } else {
                        let blogs = JSON.parse(data.Payload);
                        
                        if (blogs.length > 0){
                            userProfile.last_resp_type = 'MAP_BLOG'
                            correctContent = "May I suggest...\n\n"
                            
                            for(var i=0; i<blogs.length && i<15; i++){ 
                                correctContent += "- <a href='" + (blogs[i].url) + "'>" + (blogs[i].title) + "</a> \n"
                            }
                        }
                        
                        console.log("correctContent", correctContent)
                    }
                }).promise();
                
                if (correctContent==""){
                    correctContent = "Try again with other keywords."
                    let s = userProfile.last_location - (chatTime - 900);
                    if (s < 300){
                        if (s >= 60)
                            correctContent += " I will take note of your current location for another "+ Math.floor(s/60) +" mins.";
                        else 
                            correctContent += " After "+s+"sec, please send me your location again to start over.";
                    }
                }
            }
        }
        
        
        if (correctContent!="") {
            // Send the reply
            await telegramBot.sendMessage(chatRoom, correctContent, {"parse_mode":"HTML",disable_web_page_preview:true});
        }
        else { 
            let newChat = userProfile.last_chat <= (chatTime - 60); 
            await sendDefaultReply(chatRoom, newChat, msgContent);
        }
        
        
        // Save user profile & action
        userProfile.last_chat = chatTime
        
        console.log('Storing userProfile to DB', userProfile)
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
        await documentClient.put(contentParam, (err)=>{
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
