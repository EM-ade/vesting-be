import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

export function validate(schema: z.ZodSchema<any>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: 'Validation error',
          details: error.issues.map((e: any) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      next(error);
    }
  };
}

// Common schemas
export const schemas = {
  wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana wallet address'),

  createPool: z.object({
    name: z.string().min(3).max(50),
    description: z.string().optional(),
    total_pool_amount: z.number().positive(),
    vesting_duration_days: z.number().positive(),
    cliff_duration_days: z.number().min(0).optional(),
    start_time: z.string().datetime().optional(),
    vesting_mode: z.enum(['snapshot', 'dynamic', 'manual']),
    adminWallet: z.string().optional(), // Sometimes passed for logging
  }),

  claimVesting: z.object({
    userWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana wallet address'),
    amountToClaim: z.number().positive().optional(),
  }),
};
