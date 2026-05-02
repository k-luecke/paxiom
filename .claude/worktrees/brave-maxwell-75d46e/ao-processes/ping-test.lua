local json = require('json')

--Paxiom: Ethereum consensus verifier
--First handler: echo test

Handlers.add(
 "Ping",
 function(msg)
   return msg.Action == "Ping"
 end,
 function(msg)
   ao.send({
     Target = msg.From,
     Data = "Paxiom is alive"
   })
  end 
)
