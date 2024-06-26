import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dtos/order.create.dto';
import { HttpService } from '@nestjs/axios';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { v4 as uuidv4 } from 'uuid';
import { OrderStatusEnum } from 'src/enums/orderStatus.enum';
import { ConfigService } from '@nestjs/config';
import { ClientKafka, ClientGrpc } from '@nestjs/microservices';
import { OrderRepository } from './repository/order.repository';
import { from, lastValueFrom, Observable, firstValueFrom } from 'rxjs';
import configuration from 'src/configs/configuration';
import Stripe from 'stripe';
import { InventoryService } from '../inventory/inventory.service';
@Injectable()
export class OrderService implements OnModuleInit {
  private readonly inventoryServiceUrl: string;
  private readonly productServiceUrl: string;
  private readonly userServiceUrl: string;
  private inventoryServiceGrpc: any;
  private readonly stripe: any;

  constructor(
    private readonly orderRepository: OrderRepository,
    private httpService: HttpService,
    @InjectRedis() private readonly clientRedis: Redis,
    private readonly configService: ConfigService,
    // @Inject('ORDER_SERVICE') private kafkaClient: ClientKafka,
    @Inject('INVENTORY_SERVICE_GRPC') private clientGrpc: ClientGrpc,
    private readonly inventoryService: InventoryService,
  ) {
    this.productServiceUrl = this.configService.get('product_service_url');
    this.inventoryServiceUrl = this.configService.get('inventory_service_url');
    this.userServiceUrl = this.configService.get('user_service_url');
    this.stripe = new Stripe(this.configService.get('stripe.secretKey'));
  }

  onModuleInit() {
    this.inventoryServiceGrpc = this.clientGrpc.getService('InventoryService');
  }

  private async checkInventoryAvailabilityAndDeduct(
    orderItems: {
      inventory_id: string;
      quantity: number;
      price: number;
    }[],
  ) {
    try {
      const response = await this.httpService.axiosRef({
        method: 'post',
        url: this.inventoryServiceUrl + '/public/inventory/purchase',
        data: orderItems,
      });

      if (response.data.data) {
        return true;
      } else {
        return false;
      }
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  private async checkInventoryAvailabilityAndDeductGrpc(
    orderItems: {
      inventory_id: string;
      quantity: number;
      price: number;
    }[],
  ) {
    return this.inventoryServiceGrpc.PurchaseInventories({
      inventories: orderItems.map((item) => ({
        inventoryId: item.inventory_id,
        quantity: item.quantity,
        price: item.price,
      })),
    });
  }

  private async returnInventoriesInCaseOfOrderFailure(orderItems) {
    try {
      const response = await this.httpService.axiosRef({
        method: 'post',
        url: this.inventoryServiceUrl + '/public/inventory/return',
        data: orderItems,
      });

      if (response.data.data) {
        return true;
      } else {
        return false;
      }
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  private async removeInventoriesFromCartAfterOrderCreation(
    userId,
    inventoryIds,
  ) {}

  async placeOrder(createOrderDto: CreateOrderDto) {
    // Step 1: Kiểm tra và trừ số lượng tồn kho
    //gprc
    // const isInventoryAvailable = await firstValueFrom(
    //   await this.checkInventoryAvailabilityAndDeductGrpc(
    //     createOrderDto.order_items,
    //   ),
    // );
    // const isInventoryAvailable =
    //   await this.checkInventoryAvailabilityAndDeductRedis(
    //     createOrderDto.order_items,
    //   );
    // console.log('isInventoryAvailable', isInventoryAvailable);
    //@ts-ignore
    // if (isInventoryAvailable.success === false) {
    //   throw new Error('Inventory is out of stock');
    // }

    //http;
    // const isInventoryAvailable = await this.checkInventoryAvailabilityAndDeduct(
    //   createOrderDto.order_items.map((item) => ({
    //     inventory_id: item.inventory_id,
    //     quantity: item.quantity,
    //     price: item.price,
    //   })),
    // );
    const isInventoryAvailable =
      await this.inventoryService.purchaseInventories(
        createOrderDto.order_items,
      );
    console.log('isInventoryAvailable', isInventoryAvailable);
    if (isInventoryAvailable === false) {
      throw new Error('Inventory is out of stock');
    }

    try {
      // Step 2: Tạo đơn hàng
      const order = await this.createOrder(createOrderDto);

      // Step 3: Xóa sản phẩm khỏi giỏ hàng
      // await this.removeInventoriesFromCartAfterOrderCreation(
      //   createOrderDto.user_id,
      //   createOrderDto.order_items.map((item) => item.inventory_id),
      // );

      if (createOrderDto.payment_method === 'MOMO') {
        let totalBill =
          createOrderDto.order_items.reduce(
            (acc, item) => acc + item.price * item.quantity,
            0,
          ) + createOrderDto.shipping_fee;
        // Step 4: Tạo payment intent
        const paymentIntent = await this.createPaymentIntentMOMO(
          order,
          totalBill,
        );
        return {
          status: 'success',
          message: 'Order placed successfully',
          order,
          payment: paymentIntent,
        };
      } else if (createOrderDto.payment_method === 'STRIPE') {
        // Step 4: Tạo payment intent
        const paymentIntent = await this.createPaymentIntentStripe(order);
        await this.clientRedis.set(
          'order:' + order + ':payment_info',
          JSON.stringify(paymentIntent),
          'EX',
          3600,
        );
        return {
          status: 'success',
          message: 'Order placed successfully',
          order,
          payment: paymentIntent,
        };
      } else {
        return {
          status: 'success',
          message: 'Order placed successfully',
          order,
        };
      }
    } catch (error) {
      // Rollback Step 1: Hoàn trả lại số lượng tồn kho đã trừ
      await this.returnInventoriesInCaseOfOrderFailure(
        createOrderDto.order_items.map((item) => ({
          inventory_id: item.inventory_id,
          quantity: item.quantity,
        })),
      );

      // Log lỗi và trả về thông báo lỗi
      console.error('Error placing order:', error);
      return {
        status: 'failed',
        message: 'An error occurred while placing the order',
      };
    }
  }

  async createOrder(createOrderDto: CreateOrderDto): Promise<string> {
    const code = createOrderDto.code || uuidv4();
    const currentDate = new Date();

    const total = createOrderDto.order_items.reduce(
      (acc, item) => acc + item.price * item.quantity,
      0,
    );

    const order = {
      code,
      user_id: createOrderDto.user_id,
      shop_id: createOrderDto.shop_id,
      shipping_address: createOrderDto.shipping_address,
      shipping_fee: createOrderDto.shipping_fee,
      payment_method: createOrderDto.payment_method,
      status: OrderStatusEnum.PENDING,
      total,
      created_at: currentDate,
      updated_at: currentDate,
      order_items: createOrderDto.order_items,
    };

    const randomNumber = Math.floor(Math.random() * 2);
    const queueName = `order_queue_${randomNumber}`;

    // Sử dụng pipeline để gửi nhiều lệnh Redis đồng thời
    const pipeline = this.clientRedis.pipeline();
    pipeline.set(`order:${code}`, JSON.stringify(order), 'EX', 3600);
    pipeline.rpush(queueName, JSON.stringify(order));

    try {
      await pipeline.exec();
    } catch (error) {
      console.error('Redis pipeline execution error:', error);
      throw new Error('Could not create order due to Redis error');
    }

    return code;
  }

  async findOrderByCode(code: string) {
    const order: any = await this.orderRepository.findByCode(code);
    console.log('order', order);
    if (!order) {
      throw new Error('Order not found');
    }

    let productIds = order.order_items.map((item) => item.product_id);
    const shopId = order.shop_id;
    const userId = order.user_id;
    // Sử dụng Promise.all để lấy thông tin sản phẩm và thông tin cửa hàng cùng một lúc
    const [productDetails, shopDetails, userDetails] = await Promise.all([
      this.getProductByListIds(productIds),
      this.getShopByListIds([shopId]),
      this.getUserByListIds([userId]),
    ]);

    order.shop = shopDetails[0];
    order.user = userDetails[0];

    let paymentInfo = await this.clientRedis.get(
      'order:' + code + ':payment_info',
    );
    if (paymentInfo) {
      order.payment_info = JSON.parse(paymentInfo);
    }
    order.order_items.forEach((item: any) => {
      const product = productDetails.find(
        (product: any) => product._id === item.product_id,
      );
      if (product) {
        item.product = product;
      }
    });

    return order;
  }

  async findOrdersByUserId(userId: string, page: number, limit: number) {
    return await this.orderRepository.findOrdersByUserIdWithPagination(
      userId,
      page,
      limit,
    );
  }

  async findOrdersByShopId(
    shopId: string,
    page: number,
    limit: number,
    status: string,
    code: string,
  ) {
    let orders = await this.orderRepository.findOrdersByShopIdWithPagination(
      shopId,
      page,
      limit,
      status,
      code,
    );
    if (orders.docs.length === 0) {
      return orders;
    }
    const listUserIds = orders.docs.map((order) => order.user_id);
    const userIds: any[] = [...new Set(listUserIds)];
    //console.log('userIds', userIds);
    const users = await this.getUserByListIds(userIds);
    //console.log('users', users);
    orders.docs = orders.docs.map((order) => {
      const user = users.find((user) => user._id === order.user_id);
      if (user) {
        return { ...order, user };
      }
      return order;
    });
    return orders;
  }

  //supporting function
  async getProductByListIds(ids: string[]) {
    try {
      const response = await this.httpService.axiosRef({
        url: this.productServiceUrl + '/public/product/by-list-ids',
        method: 'post',
        data: {
          ids,
          populate: [],
          includes: [
            '_id',
            'shop_id',
            'product_name',
            'is_has_many_classifications',
            'classifications',
            'images',
          ],
        },
      });

      return response.data.data;
    } catch (err) {
      console.log(err);
      return [];
    }
  }

  async getShopByListIds(ids: string[]) {
    try {
      const response = await this.httpService.axiosRef({
        url: this.userServiceUrl + '/public/shop/by-list-ids',
        method: 'post',
        data: {
          ids,
          populate: [],
          includes: [' _id', 'shop_name', 'address'],
        },
      });

      return response.data.data;
    } catch (err) {
      console.log(err);
      return [];
    }
  }

  async getUserByListIds(ids: string[]) {
    try {
      const response = await this.httpService.axiosRef({
        url: this.userServiceUrl + '/user/by-list-ids',
        method: 'post',
        data: {
          ids,
          populate: [],
          includes: ['_id', 'username', 'email', 'phone_number', 'address'],
        },
      });

      return response.data.data;
    } catch (err) {
      console.log(err);
      return [];
    }
  }

  async handleMomoIPN(body: any) {
    const { orderId, resultCode } = body;
    if (resultCode === 0) {
      await this.orderRepository.updateByCode(orderId, {
        status: OrderStatusEnum.PAID,
      });
      this.clientRedis.publish(
        'socket_queue',
        JSON.stringify({ orderId, status: OrderStatusEnum.PAID }),
      );
    } else {
      // await this.orderRepository.update(orderId, {
      //   status: OrderStatusEnum.FAILED,
      // });
    }
  }

  async createPaymentIntentStripe(orderCode: string) {
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'vnd',
            product_data: {
              name: 'T-shirt',
            },
            unit_amount: 200000,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      success_url:
        process.env.ECOMMERCE_FE_URL +
        '/orders/' +
        orderCode +
        '?paymentStatus=success',
      cancel_url:
        process.env.ECOMMERCE_FE_URL +
        '/orders/' +
        orderCode +
        '?paymentStatus=failed',
    });
    console.log('session', session);
    return session;
  }

  async createPaymentIntentMOMO(orderCode: string, totalBill: number) {
    console.log('--------------------CREATE PAYMENT INTENT----------------');
    console.log('Order code:', orderCode);
    console.log('Total bill:', totalBill);
    var accessKey = 'F8BBA842ECF85';
    var secretKey = 'K951B6PE1waDMi640xX08PD3vg6EkVlz';
    var orderInfo = 'pay with MoMo';
    var partnerCode = 'MOMO';
    var redirectUrl = process.env.ECOMMERCE_FE_URL + '/orders/' + orderCode;
    var ipnUrl =
      'https://balanced-collie-quietly.ngrok-free.app/public/order/payment/momo-ipn';
    var requestType = 'payWithMethod';
    var amount = totalBill;
    var orderId = orderCode;
    var requestId = orderId;
    var extraData = '';
    var paymentCode =
      'T8Qii53fAXyUftPV3m9ysyRhEanUs9KlOPfHgpMR0ON50U10Bh+vZdpJU7VY4z+Z2y77fJHkoDc69scwwzLuW5MzeUKTwPo3ZMaB29imm6YulqnWfTkgzqRaion+EuD7FN9wZ4aXE1+mRt0gHsU193y+yxtRgpmY7SDMU9hCKoQtYyHsfFR5FUAOAKMdw2fzQqpToei3rnaYvZuYaxolprm9+/+WIETnPUDlxCYOiw7vPeaaYQQH0BF0TxyU3zu36ODx980rJvPAgtJzH1gUrlxcSS1HQeQ9ZaVM1eOK/jl8KJm6ijOwErHGbgf/hVymUQG65rHU2MWz9U8QUjvDWA==';
    var orderGroupId = '';
    var autoCapture = true;
    var lang = 'vi';

    //before sign HMAC SHA256 with format
    //accessKey=$accessKey&amount=$amount&extraData=$extraData&ipnUrl=$ipnUrl&orderId=$orderId&orderInfo=$orderInfo&partnerCode=$partnerCode&redirectUrl=$redirectUrl&requestId=$requestId&requestType=$requestType
    var rawSignature =
      'accessKey=' +
      accessKey +
      '&amount=' +
      amount +
      '&extraData=' +
      extraData +
      '&ipnUrl=' +
      ipnUrl +
      '&orderId=' +
      orderId +
      '&orderInfo=' +
      orderInfo +
      '&partnerCode=' +
      partnerCode +
      '&redirectUrl=' +
      redirectUrl +
      '&requestId=' +
      requestId +
      '&requestType=' +
      requestType;
    //puts raw signature
    console.log('--------------------RAW SIGNATURE----------------');
    console.log(rawSignature);
    //signature
    const crypto = require('crypto');
    var signature = crypto
      .createHmac('sha256', secretKey)
      .update(rawSignature)
      .digest('hex');
    console.log('--------------------SIGNATURE----------------');
    console.log(signature);

    //json object send to MoMo endpoint
    const requestBody = JSON.stringify({
      partnerCode: partnerCode,
      partnerName: 'Test',
      storeId: 'MomoTestStore',
      requestId: requestId,
      amount: amount,
      orderId: orderId,
      orderInfo: orderInfo,
      redirectUrl: redirectUrl,
      ipnUrl: ipnUrl,
      lang: lang,
      requestType: requestType,
      autoCapture: autoCapture,
      extraData: extraData,
      orderGroupId: orderGroupId,
      signature: signature,
    });

    try {
      const response = await this.httpService.axiosRef({
        url: 'https://test-payment.momo.vn/v2/gateway/api/create',
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
        },
        data: requestBody,
      });

      console.log('--------------------RESPONSE----------------');
      console.log(response.data);

      return response.data;
    } catch (err) {
      console.log(err);
      return {};
    }
  }

  async changeOrderStatus(orderCode: string, status: string, data: any = {}) {
    await this.orderRepository.updateByCode(orderCode, {
      status,
    });
    this.clientRedis.publish(
      'socket_queue',
      JSON.stringify({ orderId: orderCode, status }),
    );
  }

  async setOrderPaymentInfo(orderCode: string, paymentInfo: any) {
    await this.orderRepository.updateByCode(orderCode, {
      payment_info: paymentInfo,
    });
  }

  extractOrderCode(urlString) {
    try {
      // Tạo đối tượng URL từ chuỗi URL
      const parsedUrl = new URL(urlString);

      // Lấy đường dẫn pathname
      const pathname = parsedUrl.pathname;

      // Sử dụng biểu thức chính quy để trích xuất mã đơn hàng
      const match = pathname.match(/\/orders\/([^\/?]+)/);

      if (match) {
        return match[1];
      } else {
        throw new Error('Order code not found');
      }
    } catch (error) {
      console.error('Error extracting order code:', error.message);
      return null;
    }
  }

  async handleStripeWebhook(body: any) {
    //console.log('Stripe webhook received', body);
    const event = body;
    const session = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        console.log('Payment was successful!');
        const orderCode = this.extractOrderCode(session.success_url);
        await this.handlePaymentSuccess(orderCode, session);
        break;
      case 'checkout.session.async_payment_failed':
        console.log('Checkout session async payment failed!');
        break;
      case 'checkout.session.async_payment_succeeded':
        console.log('Checkout session async payment succeeded!');
        break;
      case 'checkout.session.expired':
        console.log('Checkout session expired!');
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  }

  async handlePlaced(orderCode: string) {
    //don't need to do anything
  }

  async handlePaymentFailed(orderCode: string) {
    const order = await this.orderRepository.findByCode(orderCode);
    if (!order) {
      return;
    }
    await this.returnInventoriesInCaseOfOrderFailure(
      order.order_items.map((item) => ({
        inventory_id: item.inventory_id,
        quantity: item.quantity,
      })),
    );
    await this.changeOrderStatus(orderCode, OrderStatusEnum.CANCELLED, {});
  }

  async handlePaymentSuccess(orderCode: string, paymentInfo: any) {
    await this.setOrderPaymentInfo(orderCode, paymentInfo);
    await this.changeOrderStatus(orderCode, OrderStatusEnum.PAID, {});
    await this.clientRedis.publish(
      'socket_queue',
      JSON.stringify({ orderId: orderCode, status: OrderStatusEnum.PAID }),
    );
  }

  async handleConfirmed(orderCode: string) {
    //create shipping order
  }

  async handleShippingCreated(orderCode: string) {
    //await this.changeOrderStatus(orderCode, OrderStatusEnum.SHIPPING, {});
  }

  async handleShippingSuccess(orderCode: string) {
    await this.changeOrderStatus(orderCode, OrderStatusEnum.DELIVERED, {});
  }

  async handleDelivered(orderCode: string) {
    await this.changeOrderStatus(orderCode, OrderStatusEnum.DONE, {});
  }
}
