const { parentPort } = require("worker_threads");
const { MongoClient } = require("mongodb");
const Redis = require("ioredis");
const { Kafka } = require("kafkajs");
const { promisify } = require("util");

(async () => {
  console.log("Worker started");

  // Kết nối MongoDB
  const mongoClient = new MongoClient("mongodb://localhost:27017", {});

  try {
    await mongoClient.connect();
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    return;
  }

  // Kết nối Redis
  const redisClient = new Redis({
    port: 6380,
    host: "localhost",
  });

  redisClient.on("connect", () => {
    console.log("Connected to Redis");

    // Chuyển phương thức lpop thành asynchronous bằng cách sử dụng promisify
    const lpopAsync = promisify(redisClient.lpop).bind(redisClient);

    // Lắng nghe message từ parent thread để nhận queue name
    parentPort.on("message", async (data) => {
      if (data.message === "start" && data.queue) {
        const queueName = data.queue;
        console.log(`Worker will start processing from queue: ${queueName}`);

        // Hàm xử lý việc lấy và insert đơn hàng vào MongoDB
        const processOrders = async () => {
          try {
            console.log(`Processing orders from ${queueName}...`);
            const orders = [];
            let order = await lpopAsync(queueName);
            while (order) {
              orders.push(JSON.parse(order));
              order = await lpopAsync(queueName);
            }

            if (orders.length > 0) {
              const db = mongoClient.db("order-service");
              const collection = db.collection("orders");

              // Thực hiện insert many vào MongoDB
              const result = await collection.insertMany(orders);
              console.log(
                "Inserted",
                result.insertedCount,
                "orders into MongoDB"
              );
            }
          } catch (error) {
            console.error("Error processing orders:", error);
          }
        };

        // Đặt interval để xử lý đơn hàng mỗi 0.2 giây
        setInterval(processOrders, 200);
      }
    });
  });

  redisClient.on("error", (error) => {
    console.error("Redis connection error:", error);
  });
})();
