import fastifyFormBody from '@fastify/formbody';
import fastifyJwt from '@fastify/jwt';
import fastifySwagger from '@fastify/swagger';
import fastify, { FastifyInstance } from 'fastify';

import { config } from '~/config';
import { database } from '~/database';
import { getPaymentProvider } from '~/payment_providers';
import { triggerWebhook } from '~/webhook';

import { customerEndpoints } from './endpoints/customer';
import { invoiceEndpoints } from './endpoints/invoice';
import { subscriptionEndpoints } from './endpoints/subscriptions';

export async function init(): Promise<FastifyInstance> {
  const server = fastify({
    logger: true,
  });

  await server.register(fastifyJwt, {
    secret: config.jwtSecret,
  });

  server.addHook('onRequest', async (request, reply) => {
    if (!request.routerPath) {
      await reply.code(404).send({
        error: 'Not found',
      });
      return;
    }

    // skip requests to our docs
    if (request.routerPath?.startsWith('/documentation')) {
      return;
    }

    if (request.routerPath === '/payment/webhook') {
      return;
    }

    try {
      await request.jwtVerify();
    } catch (err) {
      await reply.send(err);
    }
  });

  await server.register(fastifyFormBody);

  await server.register(fastifySwagger, {
    routePrefix: '/documentation',
    swagger: {
      info: {
        title: 'Gringotts api',
        description: 'Documentation for the Gringotts api',
        version: '0.1.0',
      },
      host: 'localhost:3000',
      schemes: ['http', 'https'],
      consumes: ['application/json'],
      produces: ['application/json'],
      securityDefinitions: {
        authorization: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
        },
      },
      security: [{ authorization: [] }],
    },
    refResolver: {
      buildLocalReference(json) {
        if (!json.title && json.$id) {
          json.title = json.$id;
        }
        return json.$id as string;
      },
    },
    exposeRoute: true,
  });

  server.addSchema({
    $id: 'SuccessResponse',
    type: 'object',
    description: 'Success response',
    properties: {
      ok: { type: 'boolean' },
    },
  });

  server.addSchema({
    $id: 'ErrorResponse',
    type: 'object',
    description: 'Error response',
    properties: {
      error: { type: 'string' },
    },
  });

  server.addSchema({
    $id: 'Invoice',
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            units: { type: 'number' },
            pricePerUnit: { type: 'number' },
          },
        },
      },
      start: { type: 'string' },
      end: { type: 'string' },
    },
  });

  server.addSchema({
    $id: 'Customer',
    type: 'object',
    properties: {
      _id: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
    },
  });

  server.addSchema({
    $id: 'SubscriptionChange',
    type: 'object',
    properties: {
      _id: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      pricePerUnit: { type: 'number' },
      units: { type: 'number' },
    },
  });

  server.addSchema({
    $id: 'Subscription',
    type: 'object',
    properties: {
      _id: { type: 'string' },
      anchorDate: { type: 'string' },
      lastPayment: { type: 'string' },
      customer: { $ref: 'Customer' },
      changes: {
        type: 'array',
        items: { $ref: 'SubscriptionChange' },
      },
    },
  });

  server.post('/payment/webhook', {
    schema: { hide: true },
    handler: async (request, reply) => {
      const paymentProvider = getPaymentProvider();
      if (!paymentProvider) {
        return reply.code(500).send({
          error: 'Payment provider not configured',
        });
      }

      const payload = await paymentProvider.parsePaymentWebhook(request.body);

      const payment = await database.payments.findOne({ _id: payload.paymentId }, { populate: ['subscription'] });
      if (!payment) {
        return reply.code(404).send({ error: 'Payment not found' });
      }

      const subscription = payment.subscription;

      if (payload.paymentStatus === 'paid') {
        subscription.lastPayment = payload.paidAt;
      }

      await database.em.persistAndFlush([payment, subscription]);

      const token = server.jwt.sign({ subscriptionId: subscription._id }, { expiresIn: '12h' });
      void triggerWebhook({
        body: {
          subscriptionId: subscription._id,
        },
        token,
      });

      await reply.send({ ok: true });
    },
  });

  subscriptionEndpoints(server);
  customerEndpoints(server);
  invoiceEndpoints(server);

  return server;
}
