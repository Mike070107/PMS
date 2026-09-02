import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Material,
  Stock,
  StockLot,
  StockMovement,
  StocktakeItem,
  StocktakeTask,
  Warehouse,
  WarehouseLocation,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { StocktakeController } from './stocktake.controller';
import { StocktakeService } from './stocktake.service';

@Module({
  imports: [
    UploadModule,
    TypeOrmModule.forFeature([
      StocktakeTask,
      StocktakeItem,
      Warehouse,
      WarehouseLocation,
      Material,
      Stock,
      StockLot,
      StockMovement,
    ]),
  ],
  controllers: [StocktakeController],
  providers: [StocktakeService],
})
export class StocktakeModule {}
