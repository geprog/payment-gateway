import { FastifyInstance } from 'fastify';

import { getProjectFromRequest } from '~/api/helpers';
import { database } from '~/database';
import { Payment } from '~/entities';
import { getPaymentProvider } from '~/payment_providers';

export function paymentMethodEndpoints(server: FastifyInstance): void {
  server.post('/payment-method', {
    schema: {
      summary: 'Create and verify a payment-method',
      tags: ['payment-method'],
      body: {
        type: 'object',
        required: ['redirectUrl', 'customerId'],
        additionalProperties: false,
        properties: {
          redirectUrl: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            paymentMethodId: { type: 'string' },
            checkoutUrl: { type: 'string' },
          },
        },
        400: {
          $ref: 'ErrorResponse',
        },
        404: {
          $ref: 'ErrorResponse',
        },
        500: {
          $ref: 'ErrorResponse',
        },
      },
    },
    handler: async (request, reply) => {
      const project = await getProjectFromRequest(request);

      const body = request.body as {
        redirectUrl: string;
        customerId: string;
      };

      const customer = await database.customers.findOne({ _id: body.customerId, project });
      if (!customer) {
        return reply.code(404).send({
          error: 'Customer not found',
        });
      }

      const paymentProvider = getPaymentProvider(project);
      if (!paymentProvider) {
        return reply.code(500).send({
          error: 'Payment provider not configured',
        });
      }

      const payment = new Payment({
        amount: 1, // TODO: Use the smallest amount possible
        currency: 'EUR', // TODO: Allow to configure this
        description: 'Payment method verification',
        customer,
        status: 'pending',
      });

      const { checkoutUrl } = await paymentProvider.chargeForegroundPayment({
        project,
        payment,
        redirectUrl: body.redirectUrl,
      });

      await database.em.persistAndFlush([payment]);

      await reply.send({
        checkoutUrl,
      });
    },
  });

  server.get('/payment-method/:paymentMethodId', {
    schema: {
      summary: 'Get a payment-method',
      tags: ['payment-method'],
      params: {
        type: 'object',
        required: ['paymentMethodId'],
        additionalProperties: false,
        properties: {
          paymentMethodId: { type: 'string' },
        },
      },
      response: {
        200: {
          $ref: 'PaymentMethod',
        },
        404: {
          $ref: 'ErrorResponse',
        },
      },
    },
    handler: async (request, reply) => {
      const project = await getProjectFromRequest(request);

      const { paymentMethodId } = request.params as { paymentMethodId: string };

      const paymentMethod = await database.paymentMethods.findOne({ _id: paymentMethodId, project });
      if (!paymentMethod) {
        return reply.code(404).send({ error: 'Payment-method not found' });
      }

      await reply.send(paymentMethod);
    },
  });

  server.delete('/payment-method/:paymentMethodId', {
    schema: {
      summary: 'Delete a payment method',
      tags: ['payment-method'],
      params: {
        type: 'object',
        required: ['paymentMethodId'],
        additionalProperties: false,
        properties: {
          paymentMethodId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
        404: {
          $ref: 'ErrorResponse',
        },
      },
    },
    handler: async (request, reply) => {
      const project = await getProjectFromRequest(request);

      const { paymentMethodId } = request.params as { paymentMethodId: string };

      const paymentMethod = await database.paymentMethods.findOne({ _id: paymentMethodId, project });
      if (!paymentMethod) {
        return reply.code(404).send({ error: 'Payment-method not found' });
      }

      await database.paymentMethods.removeAndFlush(paymentMethod);

      await reply.send({ success: true });
    },
  });
}
