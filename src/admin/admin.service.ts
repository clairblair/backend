import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Investment, InvestmentDocument } from '../investments/schemas/investment.schema';
import { Withdrawal, WithdrawalDocument } from '../withdrawals/schemas/withdrawal.schema';
import { Wallet, WalletDocument, WalletType } from '../wallet/schemas/wallet.schema';
import { InvestmentPlan, InvestmentPlanDocument } from '../investment-plans/schemas/investment-plan.schema';
import { Notice, NoticeDocument } from '../schemas/notice.schema';
import { Settings, SettingsDocument } from '../schemas/settings.schema';
import { UsersService } from '../users/users.service';
import { InvestmentsService } from '../investments/investments.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { WalletService } from '../wallet/wallet.service';
import { InvestmentPlansService } from '../investment-plans/investment-plans.service';
import { NoticeService } from '../notice/notice.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TransactionStatus } from '../transactions/schemas/transaction.schema';
import { NotificationType, NotificationCategory } from '../notifications/schemas/notification.schema';
import { TransactionsService } from '../transactions/transactions.service';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Investment.name) private investmentModel: Model<InvestmentDocument>,
    @InjectModel(Withdrawal.name) private withdrawalModel: Model<WithdrawalDocument>,
    @InjectModel(Wallet.name) private walletModel: Model<WalletDocument>,
    @InjectModel(InvestmentPlan.name) private planModel: Model<InvestmentPlanDocument>,
    @InjectModel(Notice.name) private noticeModel: Model<NoticeDocument>,
    @InjectModel(Settings.name) private settingsModel: Model<SettingsDocument>,
    private readonly usersService: UsersService,
    private readonly investmentsService: InvestmentsService,
    @Inject(forwardRef(() => WithdrawalsService)) private readonly withdrawalsService: WithdrawalsService,
    private readonly walletService: WalletService,
    private readonly plansService: InvestmentPlansService,
    private readonly noticeService: NoticeService,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  // Dashboard Stats
  async getDashboardStats() {
    const [
      totalUsers,
      totalInvestments,
      totalWithdrawals,
      totalPlans,
      activeUsers,
      activeInvestments,
      pendingWithdrawals,
    ] = await Promise.all([
      this.userModel.countDocuments(),
      this.investmentModel.countDocuments(),
      this.withdrawalModel.countDocuments(),
      this.planModel.countDocuments(),
      this.userModel.countDocuments({ status: true }),
      this.investmentModel.countDocuments({ status: 'active' }),
      this.withdrawalModel.countDocuments({ status: 'pending' }),
    ]);

    return {
      totalUsers,
      totalInvestments,
      totalWithdrawals,
      totalPlans,
      activeUsers,
      activeInvestments,
      pendingWithdrawals,
    };
  }

  // User Management
  async getAllUsers(query: any) {
    const { status, role, verification, search, dateRange, page = 1, limit = 10 } = query;
    const filter: any = {};

    if (status && status !== 'all') {
      filter.isActive = status === 'active';
    }
    if (role && role !== 'all') {
      filter.role = role;
    }
    if (verification && verification !== 'all') {
      if (verification === 'verified') {
        filter.$and = [
          { isEmailVerified: true },
          { isPhoneVerified: true }
        ];
      } else if (verification === 'unverified') {
        filter.$or = [
          { isEmailVerified: false },
          { isPhoneVerified: false }
        ];
      }
    }
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { referralCode: { $regex: search, $options: 'i' } }
      ];
    }
    if (dateRange && dateRange !== 'all') {
      const now = new Date();
      let startDate;
      switch (dateRange) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
      }
      if (startDate) {
        filter.createdAt = { $gte: startDate };
      }
    }

    const skip = (page - 1) * limit;
    const users = await this.userModel
      .find(filter)
      .select('-password')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await this.userModel.countDocuments(filter);

    return {
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getUsersStats() {
    const [totalUsers, activeUsers, inactiveUsers, totalAdmins, newUsersThisMonth, verifiedUsers, unverifiedUsers] = await Promise.all([
      this.userModel.countDocuments(),
      this.userModel.countDocuments({ isActive: true }),
      this.userModel.countDocuments({ isActive: false }),
      this.userModel.countDocuments({ role: 'admin' }),
      this.userModel.countDocuments({
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
      }),
      this.userModel.countDocuments({
        $and: [
          { isEmailVerified: true },
          { isPhoneVerified: true }
        ]
      }),
      this.userModel.countDocuments({
        $or: [
          { isEmailVerified: false },
          { isPhoneVerified: false }
        ]
      }),
    ]);

    return {
      totalUsers,
      activeUsers,
      inactiveUsers,
      totalAdmins,
      newUsersThisMonth,
      verifiedUsers,
      unverifiedUsers,
    };
  }

  async getUsersAnalytics() {
    // Get user stats first
    const stats = await this.getUsersStats();
    
    // User growth over time
    const userGrowth = await this.userModel.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      { $limit: 30 }
    ]);

    // Top referrers
    const topReferrers = await this.userModel.aggregate([
      { $match: { referralCount: { $gt: 0 } } },
      { $sort: { referralCount: -1 } },
      { $limit: 10 },
      {
        $project: {
          user: { $concat: ['$firstName', ' ', '$lastName'] },
          referrals: '$referralCount'
        }
      }
    ]);

    // User engagement (active vs inactive)
    const userActivity = await this.userModel.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$lastLoginAt' },
            month: { $month: '$lastLoginAt' }
          },
          active: {
            $sum: {
              $cond: [
                { $gte: ['$lastLoginAt', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)] },
                1,
                0
              ]
            }
          },
          inactive: {
            $sum: {
              $cond: [
                { $lt: ['$lastLoginAt', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)] },
                1,
                0
              ]
            }
          }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $limit: 12 }
    ]);

    return {
      userGrowth: userGrowth.map(item => ({
        date: `${item._id.year}-${item._id.month}-${item._id.day}`,
        count: item.count
      })),
      topReferrers,
      userActivity: userActivity.map(item => ({
        date: `${item._id.year}-${item._id.month}`,
        active: item.active,
        inactive: item.inactive
      })),
      userEngagement: [
        { category: 'Active Users', percentage: (stats.activeUsers / stats.totalUsers) * 100 },
        { category: 'Verified Users', percentage: (stats.verifiedUsers / stats.totalUsers) * 100 },
        { category: 'Premium Users', percentage: 15 }, // Example
        { category: 'New Users', percentage: (stats.newUsersThisMonth / stats.totalUsers) * 100 }
      ]
    };
  }

  async updateUser(id: string, updateData: any) {
    const user = await this.userModel.findByIdAndUpdate(id, updateData, { new: true }).select('-password');
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async deleteUser(id: string) {
    const user = await this.userModel.findByIdAndDelete(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { message: 'User deleted successfully' };
  }

  // Investment Management
  async getAllInvestments(query: any) {
    const { status, currency, page = 1, limit = 10 } = query;
    const filter: any = {};

    if (status && status !== 'all') {
      filter.status = status;
    }
    if (currency && currency !== 'all') {
      filter.currency = currency;
    }

    const skip = (page - 1) * limit;
    const investments = await this.investmentModel
      .find(filter)
      .populate('userId', 'firstName lastName email')
      .populate('planId', 'name')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await this.investmentModel.countDocuments(filter);

    // Map to return user and plan fields
    const mappedInvestments = investments.map(inv => ({
      ...inv.toObject(),
      user: inv.userId,
      plan: inv.planId,
    }));

    return {
      investments: mappedInvestments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getInvestmentsStats() {
    const [totalInvestments, totalAmount, totalEarnings, activeInvestments, completedInvestments, pendingInvestments] = await Promise.all([
      this.investmentModel.countDocuments(),
      this.investmentModel.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      this.investmentModel.aggregate([{ $group: { _id: null, total: { $sum: '$earnedAmount' } } }]),
      this.investmentModel.countDocuments({ status: 'active' }),
      this.investmentModel.countDocuments({ status: 'completed' }),
      this.investmentModel.countDocuments({ status: 'pending' }),
    ]);

    return {
      totalInvestments,
      totalAmount: totalAmount[0]?.total || 0,
      totalEarnings: totalEarnings[0]?.total || 0,
      activeInvestments,
      completedInvestments,
      pendingInvestments,
    };
  }

  async updateInvestment(id: string, updateData: any) {
    const investment = await this.investmentModel.findByIdAndUpdate(id, updateData, { new: true });
    if (!investment) {
      throw new NotFoundException('Investment not found');
    }
    return investment;
  }

  async deleteInvestment(id: string) {
    const investment = await this.investmentModel.findByIdAndDelete(id);
    if (!investment) {
      throw new NotFoundException('Investment not found');
    }
    return { message: 'Investment deleted successfully' };
  }

  // Withdrawal Management
  async getAllWithdrawals(query: any) {
    const { status, currency, page = 1, limit = 10 } = query;
    const filter: any = {};

    if (status && status !== 'all') {
      filter.status = status;
    }
    if (currency && currency !== 'all') {
      filter.currency = currency;
    }

    const skip = (page - 1) * limit;
    const withdrawals = await this.withdrawalModel
      .find(filter)
      .populate('userId', 'firstName lastName email')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await this.withdrawalModel.countDocuments(filter);

    // Map to return user field
    const mappedWithdrawals = withdrawals.map(w => ({
      ...w.toObject(),
      user: w.userId,
    }));

    return {
      withdrawals: mappedWithdrawals,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getWithdrawalsStats() {
    const [totalWithdrawals, totalAmount, totalFees, pendingWithdrawals, completedWithdrawals, failedWithdrawals] = await Promise.all([
      this.withdrawalModel.countDocuments(),
      this.withdrawalModel.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      this.withdrawalModel.aggregate([{ $group: { _id: null, total: { $sum: '$fee' } } }]),
      this.withdrawalModel.countDocuments({ status: 'pending' }),
      this.withdrawalModel.countDocuments({ status: 'completed' }),
      this.withdrawalModel.countDocuments({ status: 'failed' }),
    ]);

    return {
      totalWithdrawals,
      totalAmount: totalAmount[0]?.total || 0,
      totalFees: totalFees[0]?.total || 0,
      pendingWithdrawals,
      completedWithdrawals,
      failedWithdrawals,
    };
  }

  async updateWithdrawal(id: string, updateData: any) {
    const withdrawal = await this.withdrawalModel.findById(id);
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }

    // Store the original status to check if we need to handle balance correction
    const originalStatus = withdrawal.status;
    const newStatus = updateData.status;

    // Update the withdrawal
    const updatedWithdrawal = await this.withdrawalModel.findByIdAndUpdate(id, updateData, { new: true });

    // Handle balance correction when status changes to failed
    if (originalStatus !== 'failed' && newStatus === 'failed') {
      try {
        // Refund the amount to user's wallet
        await this.walletService.deposit(withdrawal.userId.toString(), {
          walletType: WalletType.MAIN,
          amount: withdrawal.amount,
          currency: withdrawal.currency,
          description: `Refund for failed withdrawal - ${withdrawal.reference}`,
        });

        // Update the related transaction status
        if (withdrawal.transactionId) {
          await this.transactionsService.update(withdrawal.transactionId.toString(), {
            status: TransactionStatus.FAILED,
            failedAt: new Date(),
            failureReason: updateData.failureReason || 'Marked as failed by admin',
          });
        }

        // Create notification for the user
        await this.notificationsService.createTransactionNotification(
          withdrawal.userId.toString(),
          'Withdrawal Failed',
          `Your withdrawal request of ${withdrawal.currency === 'naira' ? '₦' : '$'}${withdrawal.amount.toLocaleString()} has been marked as failed. The amount has been refunded to your wallet.`,
          NotificationType.ERROR
        );

        // Send email notification
        const user = await this.userModel.findById(withdrawal.userId);
        if (user) {
          await this.emailService.sendWithdrawalFailedEmail(
            user.email,
            user.firstName || user.email,
            {
              amount: withdrawal.amount,
              currency: withdrawal.currency,
              reference: withdrawal.reference,
              failureReason: updateData.failureReason || 'Marked as failed by admin',
              refundedAmount: withdrawal.amount,
              refundedCurrency: withdrawal.currency,
            }
          );
        }

        console.log(`Balance corrected for failed withdrawal ${withdrawal.reference}: ${withdrawal.amount} ${withdrawal.currency} refunded to user ${withdrawal.userId}`);
      } catch (error) {
        console.error(`Error correcting balance for failed withdrawal ${withdrawal.reference}:`, error);
        // Don't throw error as the withdrawal status update was successful
        // The balance correction can be handled manually if needed
      }
    }

    return updatedWithdrawal;
  }

  async deleteWithdrawal(id: string) {
    const withdrawal = await this.withdrawalModel.findByIdAndDelete(id);
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    return { message: 'Withdrawal deleted successfully' };
  }

  // Wallet Management
  async getAllWallets(query: any) {
    const { status, page = 1, limit = 10 } = query;
    const filter: any = {};

    if (status && status !== 'all') {
      filter.status = status;
    }

    const skip = (page - 1) * limit;
    const wallets = await this.walletModel
      .find(filter)
      .populate('userId', 'firstName lastName email')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await this.walletModel.countDocuments(filter);

    // Map to return user field
    const mappedWallets = wallets.map(w => ({
      ...w.toObject(),
      user: w.userId,
    }));

    return {
      wallets: mappedWallets,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getWalletsStats() {
    const [totalWallets, totalBalance, totalDeposits, totalWithdrawals, activeWallets, suspendedWallets] = await Promise.all([
      this.walletModel.countDocuments(),
      this.walletModel.aggregate([
        {
          $group: {
            _id: null,
            naira: { $sum: '$nairaBalance' },
            usdt: { $sum: '$usdtBalance' },
          },
        },
      ]),
      this.walletModel.aggregate([{ $group: { _id: null, total: { $sum: '$totalDeposits' } } }]),
      this.walletModel.aggregate([{ $group: { _id: null, total: { $sum: '$totalWithdrawals' } } }]),
      this.walletModel.countDocuments({ status: 'active' }),
      this.walletModel.countDocuments({ status: 'suspended' }),
    ]);

    return {
      totalWallets,
      totalBalance: {
        naira: totalBalance[0]?.naira || 0,
        usdt: totalBalance[0]?.usdt || 0,
      },
      totalDeposits: totalDeposits[0]?.total || 0,
      totalWithdrawals: totalWithdrawals[0]?.total || 0,
      activeWallets,
      suspendedWallets,
    };
  }

  async adminDeposit(walletId: string, depositData: any) {
    const { amount, currency, reason } = depositData;
    const wallet = await this.walletModel.findById(walletId);
    
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    if (currency === 'naira') {
      wallet.nairaBalance += amount;
      wallet.totalDeposits += amount;
    } else {
      wallet.usdtBalance += amount;
      wallet.totalDeposits += amount;
    }

    wallet.lastTransactionDate = new Date();
    await wallet.save();

    return wallet;
  }

  async adminWithdraw(walletId: string, withdrawalData: any) {
    const { amount, currency, reason } = withdrawalData;
    const wallet = await this.walletModel.findById(walletId);
    
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    if (currency === 'naira' && wallet.nairaBalance < amount) {
      throw new BadRequestException('Insufficient naira balance');
    }
    if (currency === 'usdt' && wallet.usdtBalance < amount) {
      throw new BadRequestException('Insufficient USDT balance');
    }

    if (currency === 'naira') {
      wallet.nairaBalance -= amount;
      wallet.totalWithdrawals += amount;
    } else {
      wallet.usdtBalance -= amount;
      wallet.totalWithdrawals += amount;
    }

    wallet.lastTransactionDate = new Date();
    await wallet.save();

    return wallet;
  }

  async updateWallet(id: string, updateData: any) {
    const wallet = await this.walletModel.findByIdAndUpdate(id, updateData, { new: true });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return wallet;
  }

  // Investment Plans Management
  async getAllPlans(query: any) {
    const { status, currency, search, page = 1, limit = 10 } = query;
    const filter: any = {};

    if (status && status !== 'all') {
      filter.status = status;
    }
    if (currency && currency !== 'all') {
      filter.currency = currency;
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * limit;
    const plans = await this.planModel
      .find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ priority: -1, createdAt: -1 });

    const total = await this.planModel.countDocuments(filter);

    return {
      plans,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getPlansStats() {
    const [totalPlans, activePlans, totalInvestments, totalAmount, totalEarnings, popularPlans, recommendedPlans] = await Promise.all([
      this.planModel.countDocuments(),
      this.planModel.countDocuments({ status: 'active' }),
      this.investmentModel.countDocuments(),
      this.investmentModel.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      this.investmentModel.aggregate([{ $group: { _id: null, total: { $sum: '$earnedAmount' } } }]),
      this.planModel.countDocuments({ isPopular: true }),
      this.planModel.countDocuments({ isRecommended: true }),
    ]);

    // Calculate average ROI
    const plansWithRoi = await this.planModel.find().select('dailyRoi');
    const averageRoi = plansWithRoi.length > 0 
      ? plansWithRoi.reduce((sum, plan) => sum + plan.dailyRoi, 0) / plansWithRoi.length 
      : 0;

    return {
      totalPlans,
      activePlans,
      totalInvestments,
      totalAmount: totalAmount[0]?.total || 0,
      totalEarnings: totalEarnings[0]?.total || 0,
      averageRoi: Math.round(averageRoi * 100) / 100,
      popularPlans,
      recommendedPlans,
    };
  }

  async getPlansAnalytics() {
    // Plan performance based on completion rate and earnings
    const planPerformance = await this.investmentModel.aggregate([
      {
        $group: {
          _id: '$planId',
          totalInvestments: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          totalEarnings: { $sum: '$earnedAmount' },
          completedInvestments: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      },
      {
        $lookup: {
          from: 'investmentplans',
          localField: '_id',
          foreignField: '_id',
          as: 'plan'
        }
      },
      {
        $unwind: '$plan'
      },
      {
        $project: {
          planId: '$_id',
          planName: '$plan.name',
          performance: {
            $multiply: [
              {
                $divide: [
                  '$completedInvestments',
                  { $max: ['$totalInvestments', 1] }
                ]
              },
              100
            ]
          }
        }
      },
      { $sort: { performance: -1 } }
    ]);

    // Investment trends over time
    const investmentTrends = await this.investmentModel.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          amount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      { $limit: 30 }
    ]);

    // ROI comparison
    const roiComparison = await this.planModel.find().select('_id name dailyRoi totalRoi').lean();

    // User preferences by currency
    const userPreferences = await this.investmentModel.aggregate([
      {
        $group: {
          _id: '$currency',
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          currency: '$_id',
          percentage: {
            $multiply: [
              {
                $divide: [
                  '$count',
                  { $sum: '$count' }
                ]
              },
              100
            ]
          }
        }
      }
    ]);

    return {
      planPerformance,
      investmentTrends: investmentTrends.map(item => ({
        date: `${item._id.year}-${item._id.month}-${item._id.day}`,
        amount: item.amount,
        count: item.count
      })),
      roiComparison,
      userPreferences,
    };
  }

  async createPlan(createData: any) {
    // Add performance tracking fields
    const planData = {
      ...createData,
      totalInvestments: 0,
      totalAmount: 0,
      totalEarnings: 0,
      activeInvestments: 0,
      completionRate: 0,
      averageRating: 0,
    };

    const plan = new this.planModel(planData);
    return await plan.save();
  }

  async updatePlan(id: string, updateData: any) {
    const plan = await this.planModel.findByIdAndUpdate(id, updateData, { new: true });
    if (!plan) {
      throw new NotFoundException('Investment plan not found');
    }
    return plan;
  }

  async deletePlan(id: string) {
    // Check if plan has active investments
    const activeInvestments = await this.investmentModel.countDocuments({
      planId: id,
      status: { $in: ['active', 'pending'] }
    });

    if (activeInvestments > 0) {
      throw new BadRequestException('Cannot delete plan with active investments');
    }

    const plan = await this.planModel.findByIdAndDelete(id);
    if (!plan) {
      throw new NotFoundException('Investment plan not found');
    }
    return plan;
  }

  // Update plan performance metrics
  async updatePlanPerformance(planId: string) {
    const investments = await this.investmentModel.find({ planId });
    
    const totalInvestments = investments.length;
    const totalAmount = investments.reduce((sum, inv) => sum + inv.amount, 0);
    const totalEarnings = investments.reduce((sum, inv) => sum + (inv.earnedAmount || 0), 0);
    const activeInvestments = investments.filter(inv => inv.status === 'active').length;
    const completedInvestments = investments.filter(inv => inv.status === 'completed').length;
    const completionRate = totalInvestments > 0 ? (completedInvestments / totalInvestments) * 100 : 0;

    await this.planModel.findByIdAndUpdate(planId, {
      totalInvestments,
      totalAmount,
      totalEarnings,
      activeInvestments,
      completionRate: Math.round(completionRate * 100) / 100,
    });
  }

  // ROI Management
  async getRoiSettings() {
    const plans = await this.planModel.find().select('_id name dailyRoi totalRoi duration currency status');
    
    const roiSettings = plans.map(plan => ({
      _id: plan._id,
      planId: plan._id,
      planName: plan.name,
      dailyRoi: plan.dailyRoi,
      totalRoi: plan.totalRoi,
      duration: plan.duration,
      currency: plan.currency,
      isActive: plan.status === 'active',
    }));

    return roiSettings;
  }

  async getRoiSettingsPaginated(query: any) {
    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;
    
    const plans = await this.planModel
      .find()
      .select('_id name dailyRoi totalRoi duration currency status')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    
    const total = await this.planModel.countDocuments();

    const roiSettings = plans.map(plan => ({
      _id: plan._id,
      planId: plan._id,
      planName: plan.name,
      dailyRoi: plan.dailyRoi,
      totalRoi: plan.totalRoi,
      duration: plan.duration,
      currency: plan.currency,
      isActive: plan.status === 'active',
    }));

    return {
      roiSettings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getRoiStats() {
    const [totalActiveInvestments, totalDailyROI, totalEarnings, averageDailyROI] = await Promise.all([
      this.investmentModel.countDocuments({ status: 'active' }),
      this.investmentModel.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, total: { $sum: '$dailyRoi' } } },
      ]),
      this.investmentModel.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, total: { $sum: '$earnedAmount' } } },
      ]),
      this.investmentModel.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, avg: { $avg: '$dailyRoi' } } },
      ]),
    ]);

    return {
      totalActiveInvestments,
      totalDailyROI: totalDailyROI[0]?.total || 0,
      totalEarnings: totalEarnings[0]?.total || 0,
      averageDailyROI: averageDailyROI[0]?.avg || 0,
    };
  }

  async updateRoiSetting(id: string, updateData: any) {
    const { dailyRoi, totalRoi, isActive } = updateData;
    const plan = await this.planModel.findByIdAndUpdate(
      id,
      {
        dailyRoi,
        totalRoi,
        status: isActive ? 'active' : 'inactive',
      },
      { new: true }
    );
    
    if (!plan) {
      throw new NotFoundException('Investment plan not found');
    }
    
    return {
      _id: plan._id,
      planId: plan._id,
      planName: plan.name,
      dailyRoi: plan.dailyRoi,
      totalRoi: plan.totalRoi,
      duration: plan.duration,
      currency: plan.currency,
      isActive: plan.status === 'active',
    };
  }

  // Settings Management
  async getSettings() {
    const doc = await this.settingsModel.findOne({ key: 'platform' });
    if (doc) return doc.value;
    // fallback to defaults
    return {
      withdrawalLimits: { minAmount: 1000, maxAmount: 1000000 },
      depositLimits: { minAmount: 100, maxAmount: 1000000 },
      fees: { withdrawalFee: 2.5, depositFee: 0, transactionFee: 1.0 },
      security: { requireEmailVerification: true, requirePhoneVerification: false, twoFactorAuth: false, sessionTimeout: 24 },
      notifications: { emailNotifications: true, smsNotifications: false, pushNotifications: true },
      maintenance: { maintenanceMode: false, maintenanceMessage: '' },
      autoPayout: false,
    };
  }

  async updateSettings(settingsData: any) {
    try {
      // Validate settings data
      this.validateSettingsData(settingsData);
      
      // Get old settings for comparison
      const oldSettings = await this.getSettings();
      
      // Update settings in database
      await this.settingsModel.updateOne(
        { key: 'platform' },
        { value: settingsData },
        { upsert: true }
      );
      
      // Handle specific setting changes that affect all users
      await this.handleSettingsChanges(oldSettings, settingsData);
      
      // Log the settings update
      console.log('Platform settings updated:', {
        oldSettings: oldSettings,
        newSettings: settingsData,
        timestamp: new Date().toISOString()
      });
      
      return settingsData;
    } catch (error) {
      console.error('Error updating platform settings:', error);
      throw new BadRequestException(`Failed to update settings: ${error.message}`);
    }
  }

  /**
   * Validate settings data before saving
   */
  private validateSettingsData(settingsData: any) {
    if (!settingsData) {
      throw new BadRequestException('Settings data is required');
    }

    // Validate withdrawal limits
    if (settingsData.withdrawalLimits) {
      if (settingsData.withdrawalLimits.minAmount < 0) {
        throw new BadRequestException('Minimum withdrawal amount cannot be negative');
      }
      if (settingsData.withdrawalLimits.maxAmount <= 0) {
        throw new BadRequestException('Maximum withdrawal amount must be positive');
      }
      if (settingsData.withdrawalLimits.minAmount >= settingsData.withdrawalLimits.maxAmount) {
        throw new BadRequestException('Minimum withdrawal amount must be less than maximum');
      }
    }

    // Validate deposit limits
    if (settingsData.depositLimits) {
      if (settingsData.depositLimits.minAmount < 0) {
        throw new BadRequestException('Minimum deposit amount cannot be negative');
      }
      if (settingsData.depositLimits.maxAmount <= 0) {
        throw new BadRequestException('Maximum deposit amount must be positive');
      }
      if (settingsData.depositLimits.minAmount >= settingsData.depositLimits.maxAmount) {
        throw new BadRequestException('Minimum deposit amount must be less than maximum');
      }
    }

    // Validate fees
    if (settingsData.fees) {
      if (settingsData.fees.withdrawalFee < 0 || settingsData.fees.withdrawalFee > 100) {
        throw new BadRequestException('Withdrawal fee must be between 0 and 100');
      }
      if (settingsData.fees.depositFee < 0 || settingsData.fees.depositFee > 100) {
        throw new BadRequestException('Deposit fee must be between 0 and 100');
      }
      if (settingsData.fees.transactionFee < 0 || settingsData.fees.transactionFee > 100) {
        throw new BadRequestException('Transaction fee must be between 0 and 100');
      }
    }

    // Validate security settings
    if (settingsData.security) {
      if (settingsData.security.sessionTimeout < 1 || settingsData.security.sessionTimeout > 168) {
        throw new BadRequestException('Session timeout must be between 1 and 168 hours');
      }
    }
  }

  /**
   * Handle specific setting changes that affect all users
   */
  private async handleSettingsChanges(oldSettings: any, newSettings: any) {
    const changes: string[] = [];

    // Check for withdrawal fee changes
    if (oldSettings?.fees?.withdrawalFee !== newSettings?.fees?.withdrawalFee) {
      changes.push(`Withdrawal fee changed from ${oldSettings?.fees?.withdrawalFee || 0}% to ${newSettings?.fees?.withdrawalFee || 0}%`);
      await this.updatePendingWithdrawalFees(newSettings.fees.withdrawalFee);
      await this.notifyUsersAboutFeeChange(newSettings.fees.withdrawalFee);
    }

    // Check for withdrawal limits changes
    if (JSON.stringify(oldSettings?.withdrawalLimits) !== JSON.stringify(newSettings?.withdrawalLimits)) {
      changes.push('Withdrawal limits updated');
      await this.notifyUsersAboutWithdrawalLimitsChange(newSettings.withdrawalLimits);
    }

    // Check for deposit limits changes
    if (JSON.stringify(oldSettings?.depositLimits) !== JSON.stringify(newSettings?.depositLimits)) {
      changes.push('Deposit limits updated');
      await this.notifyUsersAboutDepositLimitsChange(newSettings.depositLimits);
    }

    // Check for deposit fee changes
    if (oldSettings?.fees?.depositFee !== newSettings?.fees?.depositFee) {
      changes.push(`Deposit fee changed from ${oldSettings?.fees?.depositFee || 0}% to ${newSettings?.fees?.depositFee || 0}%`);
      await this.notifyUsersAboutDepositFeeChange(newSettings.fees.depositFee);
    }

    // Check for auto payout changes
    if (oldSettings?.autoPayout !== newSettings?.autoPayout) {
      changes.push(`Auto payout ${newSettings?.autoPayout ? 'enabled' : 'disabled'}`);
      await this.notifyUsersAboutAutoPayoutChange(newSettings.autoPayout);
    }

    // Check for maintenance mode changes
    if (JSON.stringify(oldSettings?.maintenance) !== JSON.stringify(newSettings?.maintenance)) {
      changes.push('Maintenance mode settings updated');
      await this.notifyUsersAboutMaintenanceModeChange(newSettings.maintenance);
    }

    // Check for security changes
    if (JSON.stringify(oldSettings?.security) !== JSON.stringify(newSettings?.security)) {
      changes.push('Security settings updated');
      await this.notifyUsersAboutSecurityChanges(newSettings.security);
    }

    if (changes.length > 0) {
      console.log('Settings changes detected:', changes);
      
      // Log the changes instead of creating an admin notification
      console.log('Platform settings updated:', changes.join(', '));
    }
  }

  /**
   * Notify users about withdrawal limits changes
   */
  private async notifyUsersAboutWithdrawalLimitsChange(limits: any) {
    try {
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      const notificationPromises = activeUsers.map(user => 
        this.notificationsService.createTransactionNotification(
          user._id.toString(),
          'Withdrawal Limits Updated',
          `Withdrawal limits have been updated. New range: ${limits.minAmount.toLocaleString()} - ${limits.maxAmount.toLocaleString()}`,
          NotificationType.INFO
        )
      );

      await Promise.all(notificationPromises);

      // Send email notifications
      const emailPromises = activeUsers.map(user =>
        this.emailService.sendEmail(
          user.email,
          'Withdrawal Limits Updated - KLT Mines',
          `
          <h2>Hello ${user.firstName || user.email}!</h2>
          <p>We want to inform you about an update to our withdrawal limits.</p>
          <p><strong>New Withdrawal Limits:</strong></p>
          <ul>
            <li>Minimum: ${limits.minAmount.toLocaleString()}</li>
            <li>Maximum: ${limits.maxAmount.toLocaleString()}</li>
          </ul>
          <p>These changes are effective immediately for all new withdrawal requests.</p>
          <p>Thank you for using KLT Mines!</p>
          `
        ).catch(error => {
          console.error(`Failed to send withdrawal limits email to ${user.email}:`, error);
        })
      );

      await Promise.all(emailPromises);
    } catch (error) {
      console.error('Error notifying users about withdrawal limits change:', error);
    }
  }

  /**
   * Notify users about deposit limits changes
   */
  private async notifyUsersAboutDepositLimitsChange(limits: any) {
    try {
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      const notificationPromises = activeUsers.map(user => 
        this.notificationsService.createTransactionNotification(
          user._id.toString(),
          'Deposit Limits Updated',
          `Deposit limits have been updated. New range: ${limits.minAmount.toLocaleString()} - ${limits.maxAmount.toLocaleString()}`,
          NotificationType.INFO
        )
      );

      await Promise.all(notificationPromises);

      // Send email notifications
      const emailPromises = activeUsers.map(user =>
        this.emailService.sendEmail(
          user.email,
          'Deposit Limits Updated - KLT Mines',
          `
          <h2>Hello ${user.firstName || user.email}!</h2>
          <p>We want to inform you about an update to our deposit limits.</p>
          <p><strong>New Deposit Limits:</strong></p>
          <ul>
            <li>Minimum: ${limits.minAmount.toLocaleString()}</li>
            <li>Maximum: ${limits.maxAmount.toLocaleString()}</li>
          </ul>
          <p>These changes are effective immediately for all new deposit requests.</p>
          <p>Thank you for using KLT Mines!</p>
          `
        ).catch(error => {
          console.error(`Failed to send deposit limits email to ${user.email}:`, error);
        })
      );

      await Promise.all(emailPromises);
    } catch (error) {
      console.error('Error notifying users about deposit limits change:', error);
    }
  }

  /**
   * Notify users about deposit fee changes
   */
  private async notifyUsersAboutDepositFeeChange(newFeePercentage: number) {
    try {
      // Get all active users
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      // Create notification for each user
      const notificationPromises = activeUsers.map(user => 
        this.notificationsService.createTransactionNotification(
          user._id.toString(),
          'Deposit Fee Updated',
          `The deposit fee has been updated to ${newFeePercentage}%. This change affects all future deposits.`,
          NotificationType.INFO
        )
      );

      await Promise.all(notificationPromises);

      // Send email notification to all users
      const emailPromises = activeUsers.map(user =>
        this.emailService.sendEmail(
          user.email,
          'Deposit Fee Updated - KLT Mines',
          `
          <h2>Hello ${user.firstName || user.email}!</h2>
          <p>We want to inform you about an update to our deposit fee.</p>
          <p><strong>New Deposit Fee:</strong> ${newFeePercentage}%</p>
          <p>This change affects all future deposits and is effective immediately.</p>
          <p>Thank you for using KLT Mines!</p>
          `
        ).catch(error => {
          console.error(`Failed to send deposit fee update email to ${user.email}:`, error);
          // Don't fail the entire operation if one email fails
        })
      );

      await Promise.all(emailPromises);

      return {
        message: `Notified ${activeUsers.length} users about deposit fee change`,
        notifiedCount: activeUsers.length
      };
    } catch (error) {
      console.error('Error notifying users about deposit fee change:', error);
      // Don't throw error as this is not critical to the fee update process
    }
  }

  /**
   * Notify users about auto payout changes
   */
  private async notifyUsersAboutAutoPayoutChange(autoPayout: boolean) {
    try {
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      const notificationPromises = activeUsers.map(user => 
        this.notificationsService.createTransactionNotification(
          user._id.toString(),
          'Auto Payout Status Updated',
          `Auto payout has been ${autoPayout ? 'enabled' : 'disabled'}. ${autoPayout ? 'Withdrawals will now be processed automatically.' : 'Withdrawals will require manual processing.'}`,
          NotificationType.INFO
        )
      );

      await Promise.all(notificationPromises);
    } catch (error) {
      console.error('Error notifying users about auto payout change:', error);
    }
  }

  /**
   * Notify users about maintenance mode changes
   */
  private async notifyUsersAboutMaintenanceModeChange(maintenance: any) {
    try {
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      if (maintenance.maintenanceMode) {
        const notificationPromises = activeUsers.map(user => 
          this.notificationsService.createTransactionNotification(
            user._id.toString(),
            'Platform Maintenance',
            `Platform maintenance is now active. ${maintenance.maintenanceMessage || 'Please check back later.'}`,
            NotificationType.WARNING
          )
        );

        await Promise.all(notificationPromises);
      }
    } catch (error) {
      console.error('Error notifying users about maintenance mode change:', error);
    }
  }

  /**
   * Notify users about security changes
   */
  private async notifyUsersAboutSecurityChanges(security: any) {
    try {
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      const changes: string[] = [];
      if (security.requireEmailVerification) changes.push('Email verification required');
      if (security.requirePhoneVerification) changes.push('Phone verification required');
      if (security.twoFactorAuth) changes.push('Two-factor authentication enabled');

      if (changes.length > 0) {
        const notificationPromises = activeUsers.map(user => 
          this.notificationsService.createTransactionNotification(
            user._id.toString(),
            'Security Settings Updated',
            `Security settings have been updated: ${changes.join(', ')}`,
            NotificationType.INFO
          )
        );

        await Promise.all(notificationPromises);
      }
    } catch (error) {
      console.error('Error notifying users about security changes:', error);
    }
  }

  /**
   * Update fees for pending withdrawals when withdrawal fee changes
   * This ensures all users are affected by the fee change
   */
  async updatePendingWithdrawalFees(newFeePercentage: number) {
    try {
      // Find all pending withdrawals
      const pendingWithdrawals = await this.withdrawalModel.find({
        status: { $in: ['pending', 'processing'] }
      });

      if (pendingWithdrawals.length === 0) {
        return { message: 'No pending withdrawals to update', updatedCount: 0 };
      }

      let updatedCount = 0;
      for (const withdrawal of pendingWithdrawals) {
        // Recalculate fee and net amount
        const newFee = withdrawal.amount * (newFeePercentage / 100);
        const newNetAmount = withdrawal.amount - newFee;

        // Update withdrawal record
        withdrawal.fee = newFee;
        withdrawal.netAmount = newNetAmount;
        await withdrawal.save();

        // Update related transaction if it exists
        if (withdrawal.transactionId) {
          await this.transactionsService.update(withdrawal.transactionId.toString(), {
            fee: newFee,
            netAmount: newNetAmount,
          });
        }

        updatedCount++;
      }

      // Notify users about the fee change
      await this.notifyUsersAboutFeeChange(newFeePercentage);

      return {
        message: `Updated fees for ${updatedCount} pending withdrawals`,
        updatedCount,
        newFeePercentage
      };
    } catch (error) {
      console.error('Error updating pending withdrawal fees:', error);
      throw new BadRequestException('Failed to update pending withdrawal fees');
    }
  }

  /**
   * Notify all users about withdrawal fee changes
   */
  async notifyUsersAboutFeeChange(newFeePercentage: number) {
    try {
      // Get all active users
      const activeUsers = await this.userModel.find({ isActive: true }).select('_id email firstName');

      // Create notification for each user
      const notificationPromises = activeUsers.map(user => 
        this.notificationsService.createTransactionNotification(
          user._id.toString(),
          'Withdrawal Fee Updated',
          `The withdrawal fee has been updated to ${newFeePercentage}%. This change affects all future withdrawals.`,
          NotificationType.INFO
        )
      );

      await Promise.all(notificationPromises);

      // Send email notification to all users
      const emailPromises = activeUsers.map(user =>
        this.emailService.sendWithdrawalFeeUpdateEmail(
          user.email,
          user.firstName || user.email,
          newFeePercentage
        ).catch(error => {
          console.error(`Failed to send fee update email to ${user.email}:`, error);
          // Don't fail the entire operation if one email fails
        })
      );

      await Promise.all(emailPromises);

      return {
        message: `Notified ${activeUsers.length} users about fee change`,
        notifiedCount: activeUsers.length
      };
    } catch (error) {
      console.error('Error notifying users about fee change:', error);
      // Don't throw error as this is not critical to the fee update process
    }
  }

  // Withdrawal Settings
  async getWithdrawalSettings() {
    const doc = await this.settingsModel.findOne({ key: 'platform' });
    if (doc) return  {
      minWithdrawalAmount: doc.value.withdrawalLimits.minAmount,
      maxWithdrawalAmount: doc.value.withdrawalLimits.maxAmount,
      withdrawalFee: doc.value.fees.withdrawalFee,
      processingTime: doc.value.processingTime,
      autoPayout: doc.value.autoPayout,
    };
    return {
      minWithdrawalAmount: 1000,
      maxWithdrawalAmount: 1000000,
      withdrawalFee: 2.5,
      processingTime: 24,
      autoPayout: false,
    };
  }

  async updateWithdrawalSettings(settingsData: any) {
    await this.settingsModel.updateOne(
      { key: 'withdrawal' },
      { value: settingsData },
      { upsert: true }
    );
    return settingsData;
  }

  // Withdrawal Policy (ROI Only toggle)
  async getWithdrawalPolicy() {
    const doc = await this.settingsModel.findOne({ key: 'platform' });
    if (doc && doc.value && doc.value.withdrawalPolicy) {
      return doc.value.withdrawalPolicy;
    }
    // Default: ROI only enforced
    return { roiOnly: true };
  }

  async updateWithdrawalPolicy(policy: { roiOnly: boolean }) {
    const doc = await this.settingsModel.findOne({ key: 'platform' });
    let value = doc?.value || {};
    value.withdrawalPolicy = { ...value.withdrawalPolicy, ...policy };
    await this.settingsModel.updateOne(
      { key: 'platform' },
      { value },
      { upsert: true }
    );
    return value.withdrawalPolicy;
  }

  // Bulk operations
  async bulkAction(userIds: string[], action: string, reason?: string) {
    const updateData: any = {
      updatedAt: new Date(),
    };

    switch (action) {
      case 'activate':
        updateData.isActive = true;
        break;
      case 'deactivate':
        updateData.isActive = false;
        break;
      case 'delete':
        // Soft delete - set isActive to false
        updateData.isActive = false;
        updateData.deactivatedAt = new Date();
        updateData.deactivatedReason = reason || 'Bulk deletion by admin';
        break;
      default:
        throw new BadRequestException('Invalid action');
    }

    const result = await this.userModel.updateMany(
      { _id: { $in: userIds } },
      updateData
    );

    return {
      message: `Bulk ${action} completed successfully`,
      affectedCount: result.modifiedCount,
    };
  }

  // Export users
  async exportUsers(format: string, filters: any) {
    const users = await this.getAllUsers({ ...filters, limit: 10000 });
    
    if (format === 'csv') {
      return this.generateCSV(users.users);
    } else if (format === 'excel') {
      return this.generateExcel(users.users);
    }
    
    throw new BadRequestException('Unsupported format');
  }

  private generateCSV(users: any[]) {
    const headers = ['ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Role', 'Status', 'Email Verified', 'Phone Verified', 'Referral Code', 'Total Referrals', 'Total Investments', 'Total Earnings', 'Wallet Balance', 'Created At'];
    const rows = users.map(user => [
      user._id,
      user.firstName,
      user.lastName,
      user.email,
      user.phone || '',
      user.role,
      user.status,
      user.isEmailVerified ? 'Yes' : 'No',
      user.isPhoneVerified ? 'Yes' : 'No',
      user.referralCode,
      user.referralCount || 0,
      user.totalInvestments || 0,
      user.totalEarnings || 0,
      user.walletBalance || 0,
      user.createdAt
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n');

    return csvContent;
  }

  private generateExcel(users: any[]) {
    // This would typically use a library like xlsx
    // For now, return CSV format
    return this.generateCSV(users);
  }

  // Advanced user operations
  async resetUserPassword(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Generate temporary password
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    user.password = hashedPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    // Send email with temporary password
    await this.emailService.sendPasswordResetEmail(user.email, user.firstName, tempPassword);

    return { tempPassword };
  }

  async verifyUser(userId: string, type: 'email' | 'phone') {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (type === 'email') {
      user.isEmailVerified = true;
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
    } else if (type === 'phone') {
      user.isPhoneVerified = true;
    }

    await user.save();
    return user;
  }

  async sendNotification(userId: string, message: string, type: string) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Create notification record
    await this.notificationsService.create({
      userId: new Types.ObjectId(userId),
      type: type.toUpperCase() as NotificationType,
      title: 'Admin Notification',
      message,
      category: NotificationCategory.SYSTEM
    });

    // Send email notification if email service supports it
    try {
      await this.emailService.sendEmail(user.email, 'Admin Notification', message);
    } catch (error) {
      // Log error but don't fail the notification
      console.error('Failed to send email notification:', error);
    }

    return { message: 'Notification sent successfully' };
  }

  // Notices Management
  async getAllNotices(query: any) {
    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;
    
    const notices = await this.noticeModel
      .find()
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await this.noticeModel.countDocuments();

    return {
      notices,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async createNotice(createData: any) {
    const notice = new this.noticeModel(createData);
    return await notice.save();
  }

  async updateNotice(id: string, updateData: any) {
    const notice = await this.noticeModel.findByIdAndUpdate(id, updateData, { new: true });
    if (!notice) {
      throw new NotFoundException('Notice not found');
    }
    return notice;
  }

  async deleteNotice(id: string) {
    const notice = await this.noticeModel.findByIdAndDelete(id);
    if (!notice) {
      throw new NotFoundException('Notice not found');
    }
    return notice;
  }
} 