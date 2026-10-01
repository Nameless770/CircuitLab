import { Module } from "@nestjs/common";
import { CircuitsController } from "./circuits.controller";
import { CircuitsService } from "./circuits.service";
import { SharesController } from "./shares.controller";
import { SharesService } from "./shares.service";

@Module({
  controllers: [CircuitsController, SharesController],
  // The repositories come from StorageModule: PostgreSQL or memory.
  providers: [CircuitsService, SharesService],
  exports: [CircuitsService],
})
export class CircuitsModule {}
