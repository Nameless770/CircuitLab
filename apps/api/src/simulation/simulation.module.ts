import { Module } from "@nestjs/common";
import { CircuitsModule } from "../circuits/circuits.module";
import { SimulationPoolService } from "./simulation-pool.service";
import { SimulationController } from "./simulation.controller";
import { SimulationService } from "./simulation.service";

@Module({
  imports: [CircuitsModule],
  controllers: [SimulationController],
  providers: [SimulationPoolService, SimulationService],
  exports: [SimulationPoolService],
})
export class SimulationModule {}
